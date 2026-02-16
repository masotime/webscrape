// @flow strict
import cheerio, { type CheerioStatic } from 'cheerio';
import http from 'http';
import https from 'https';
import path from 'path';
import fs, { type Stats } from 'fs';
import url from 'url';
import zlib from 'zlib';
import { debuglog } from 'util';

type HeaderValue = string | Array<string>;
type HeaderMap = {
	[string]: HeaderValue
};

export type CookieJar = {|
	cookies: { [string]: string }
|};

type QueryValue = string | number | boolean | Array<string | number | boolean>;
type Query = {
	[string]: QueryValue
};
type FormDataMap = Query;

type QueryStringifyOptions = {|
	arrayFormat: 'indicies' | 'repeat'
|};

export type OptionsObject = {|
	uri: string,
	headers?: HeaderMap,
	qs?: Query,
	qsStringifyOptions?: QueryStringifyOptions,
	body?: string | FormDataMap,
	form?: FormDataMap,
	json?: boolean,
	jar?: CookieJar,
	agentOptions?: http$agentOptions,
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS',
|};

export type ResponseObject = {|
	statusCode: number,
	headers: HeaderMap,
|};

export type Callback = (err: ?Error, resp?: ResponseObject, body?: string) => mixed;

const log = debuglog('webscrape');

// base options
const BASE_OPTIONS = {
	headers: {
		"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_9_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/31.0.1650.63 Safari/537.36",
		"Cache-Control": "no-cache",
		"Pragma": "no-cache"
	}
};

// fix unicode in JSON response
const UNICODE_HEADER = /\\x([0-9a-fA-F]{2})/g;

function createCookieJar(): CookieJar {
	return {
		cookies: {}
	};
}

function parseSetCookie(setCookieLine: string): ?{| name: string, value: string |} {
	const line = setCookieLine.split(';')[0];
	const eqIndex = line.indexOf('=');
	if (eqIndex <= 0) {
		return null;
	}

	const name = line.slice(0, eqIndex).trim();
	const value = line.slice(eqIndex + 1).trim();
	return { name, value };
}

function applyResponseCookies(jar: ?CookieJar, headers: HeaderMap): void {
	if (!jar || !headers) {
		return;
	}

	const rawSetCookie = headers['set-cookie'];
	if (!rawSetCookie) {
		return;
	}

	const cookieLines = Array.isArray(rawSetCookie) ? rawSetCookie : [rawSetCookie];
	cookieLines.forEach((line: string): void => {
		const parsed = parseSetCookie(line);
		if (parsed) {
			jar.cookies[parsed.name] = parsed.value;
		}
	});
}

function getCookieHeader(jar: ?CookieJar): string {
	if (!jar) {
		return '';
	}

	const cookieNames = Object.keys(jar.cookies);
	if (cookieNames.length === 0) {
		return '';
	}

	return cookieNames.map((name: string): string => `${name}=${jar.cookies[name]}`).join('; ');
}

function normalizeHeaders(headers: { [string]: mixed }): HeaderMap {
	return Object.keys(headers || {}).reduce((result: HeaderMap, key: string): HeaderMap => {
		const rawValue = headers[key];
		if (Array.isArray(rawValue)) {
			result[key.toLowerCase()] = rawValue.map((value: mixed): string => String(value));
		} else if (rawValue !== undefined && rawValue !== null) {
			result[key.toLowerCase()] = String(rawValue);
		}
		return result;
	}, {});
}

function normalizeResponse(statusCode: number, headers: { [string]: mixed }): ResponseObject {
	return {
		statusCode,
		headers: normalizeHeaders(headers)
	};
}

function hasHeader(headers: HeaderMap, key: string): boolean {
	return Object.keys(headers).some((headerKey: string): boolean => headerKey.toLowerCase() === key.toLowerCase());
}

function setHeaderIfMissing(headers: HeaderMap, key: string, value: string): void {
	if (!hasHeader(headers, key)) {
		headers[key] = value;
	}
}

function encodeValue(value: mixed): string {
	return encodeURIComponent(String(value));
}

function encodeObject(obj: Query, arrayFormat: 'indicies' | 'repeat'): string {
	const parts = [];

	Object.keys(obj || {}).forEach((key: string): void => {
		const value = obj[key];
		if (value === undefined || value === null) {
			return;
		}

		if (Array.isArray(value)) {
			value.forEach((arrayValue: mixed, index: number): void => {
				const formattedKey = arrayFormat === 'repeat' ? key : `${key}[${index}]`;
				parts.push(`${encodeURIComponent(formattedKey)}=${encodeValue(arrayValue)}`);
			});
		} else {
			parts.push(`${encodeURIComponent(key)}=${encodeValue(value)}`);
		}
	});

	return parts.join('&');
}

function appendQueryString(uri: string, query: ?Query, arrayFormat: 'indicies' | 'repeat'): string {
	if (!query) {
		return uri;
	}

	const queryString = encodeObject(query, arrayFormat);
	if (!queryString) {
		return uri;
	}

	return `${uri}${uri.includes('?') ? '&' : '?'}${queryString}`;
}

function resolveRedirectUri(currentUri: string, redirectUri: string): string {
	try {
		return new URL(redirectUri, currentUri).toString();
	} catch (err) {
		return redirectUri;
	}
}

function getRedirectLocation(headers: HeaderMap): ?string {
	const location = headers.location;
	if (!location) {
		return null;
	}

	return Array.isArray(location) ? location[0] : location;
}

function getContentEncoding(headers: HeaderMap): ?string {
	const rawEncoding = headers['content-encoding'];
	if (!rawEncoding) {
		return null;
	}

	const encoding = Array.isArray(rawEncoding) ? rawEncoding[0] : rawEncoding;
	if (!encoding) {
		return null;
	}

	return String(encoding).toLowerCase().split(',')[0].trim();
}

function decodeStream(stream: stream$Readable, headers: HeaderMap): stream$Readable {
	const contentEncoding = getContentEncoding(headers);
	if (!contentEncoding) {
		return stream;
	}

	if (contentEncoding === 'gzip') {
		return stream.pipe(zlib.createGunzip());
	}

	if (contentEncoding === 'deflate') {
		return stream.pipe(zlib.createInflate());
	}

	if (contentEncoding === 'br' && typeof zlib.createBrotliDecompress === 'function') {
		return stream.pipe(zlib.createBrotliDecompress());
	}

	return stream;
}

function extractBody(stream: stream$Readable): Promise<string> {
	return new Promise((resolve, reject) => {
		const chunks = [];
		stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
		stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		stream.on('error', reject);
	});
}

function makeRequest(options: OptionsObject): Promise<{| response: ResponseObject, stream: stream$Readable |}> {
	const method = (options.method || 'GET').toUpperCase();
	const arrayFormat = options.qsStringifyOptions && options.qsStringifyOptions.arrayFormat || 'indicies';
	const uri = appendQueryString(options.uri, options.qs, arrayFormat);
	const headers: HeaderMap = {};

	if (options.headers) {
		Object.keys(options.headers).forEach((headerName: string): void => {
			headers[headerName] = options.headers ? options.headers[headerName] : '';
		});
	}

	const cookieHeader = getCookieHeader(options.jar);
	if (cookieHeader) {
		setHeaderIfMissing(headers, 'Cookie', cookieHeader);
	}

	let requestBody;
	const form = options.form;
	if (form !== undefined) {
		setHeaderIfMissing(headers, 'Content-Type', 'application/x-www-form-urlencoded');
		requestBody = encodeObject(form, arrayFormat);
	} else if (options.body !== undefined) {
		if (options.json && typeof options.body !== 'string') {
			setHeaderIfMissing(headers, 'Content-Type', 'application/json');
			requestBody = JSON.stringify(options.body);
		} else if (typeof options.body === 'string') {
			requestBody = options.body;
		} else {
			requestBody = String(options.body);
		}
	}

	setHeaderIfMissing(headers, 'Accept-Encoding', 'gzip, deflate, br');

	if (requestBody !== undefined && !hasHeader(headers, 'Content-Length')) {
		headers['Content-Length'] = String(Buffer.byteLength(requestBody, 'utf8'));
	}

	let parsedUri;
	try {
		parsedUri = new URL(uri);
	} catch (err) {
		return Promise.reject(err);
	}

	const isHttps = parsedUri.protocol === 'https:';
	const basePath = `${parsedUri.pathname}${parsedUri.search}`;
	const parsedPort = parsedUri.port ? parseInt(parsedUri.port, 10) : undefined;
	const requestHeaders: { [string]: mixed } = {};
	Object.keys(headers).forEach((headerName: string): void => {
		requestHeaders[headerName] = headers[headerName];
	});

	return new Promise((resolve, reject) => {
		const handleResponse = (res) => {
			const response = normalizeResponse(res.statusCode || 0, res.headers || {});
			applyResponseCookies(options.jar, response.headers);

			const decoded = decodeStream(res, response.headers);
			decoded.on('error', reject);
			resolve({ response, stream: decoded });
		};

		let req;
		if (isHttps) {
			const requestOptions: https$requestOptions = {
				protocol: parsedUri.protocol,
				hostname: parsedUri.hostname,
				port: parsedPort,
				path: basePath,
				method,
				headers: requestHeaders,
				agent: options.agentOptions ? new https.Agent(options.agentOptions) : undefined,
			};
			req = https.request(requestOptions, handleResponse);
		} else {
			const requestOptions: http$requestOptions = {
				protocol: parsedUri.protocol,
				hostname: parsedUri.hostname,
				port: parsedPort,
				path: basePath,
				method,
				headers: requestHeaders,
				agent: options.agentOptions ? new http.Agent(options.agentOptions) : undefined,
			};
			req = http.request(requestOptions, handleResponse);
		}

		req.on('error', reject);

		if (requestBody !== undefined) {
			req.write(requestBody);
		}

		req.end();
	});
}

// adds additional functionality like 303 redirects while preserving existing API.
function betterRequest(options: OptionsObject, callback: Callback): void {
	makeRequest(options)
		.then(({ response, stream }): Promise<mixed> => {
			const locationUrl = getRedirectLocation(response.headers);

			if (response.statusCode === 302) {
				stream.resume();
				const err = new Error(`Unexpected Redirect to ${locationUrl || 'unknown-location'}`);
				err.name = 'UnexpectedRedirectError';
				callback(err);
				return Promise.resolve();
			}

			if ((response.statusCode === 301 || response.statusCode === 303) && locationUrl) {
				stream.resume();
				betterRequest({
					...options,
					uri: resolveRedirectUri(options.uri, locationUrl)
				}, callback);
				return Promise.resolve();
			}

			return extractBody(stream)
				.then((body: string): mixed => callback(null, response, body));
		})
		.catch((err: Error): mixed => callback(err));
}

function streamRequest(options: OptionsObject, redirectCount: number = 0): Promise<{| response: ResponseObject, stream: stream$Readable |}> {
	if (redirectCount > 10) {
		return Promise.reject(new Error(`Too many redirects for ${options.uri}`));
	}

	return makeRequest(options)
		.then(({ response, stream }): Promise<{| response: ResponseObject, stream: stream$Readable |}> => {
			const locationUrl = getRedirectLocation(response.headers);
			if (locationUrl && [301, 302, 303, 307, 308].includes(response.statusCode)) {
				stream.resume();
				return streamRequest({
					...options,
					uri: resolveRedirectUri(options.uri, locationUrl)
				}, redirectCount + 1);
			}

			return Promise.resolve({ response, stream });
		});
}

function constructError(options: OptionsObject, resp: ResponseObject, body: string): Error {
	const error = new Error();
	error.message = `${options.method || 'GET'} ERROR ${options.uri} HttpCode ${resp.statusCode}\n${body}`;
	return error;
}

export type WebscrapeResult = {|
	headers: HeaderMap,
	json?: { ... },
	body: string,
	$?: CheerioStatic
|};

// TODO: This could throw errors. Deal with it.
function constructResult(resp: ResponseObject, body: string): WebscrapeResult {
	const result: WebscrapeResult = {
		body,
		headers: resp.headers
	};

	const contentTypeValue = resp.headers['content-type'];
	const contentType = Array.isArray(contentTypeValue) ? contentTypeValue[0] : contentTypeValue;
	const mimeType = typeof contentType === 'string' ? contentType.split(';')[0] : null;
	// augment the result
	switch (mimeType) {
		case 'text/html': result.$ = cheerio.load(body, { lowerCaseTags: true }); break;
		case 'application/json': result.json = JSON.parse(body.replace(UNICODE_HEADER, (m: string, n: string): string => String.fromCharCode(parseInt(n,16))));
	}

	return result;
}

export type WebscrapeOptions = {|
	headers?: HeaderMap,
	query?: Query,
	body?: string | FormDataMap,
	jar?: CookieJar,
	agentOptions?: http$agentOptions,
	method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS',
	indicies?: boolean
|};

type KVPair = {|
	key: string,
	value: string,
|};

function constructOptionsWithJar(uri: string, { headers, query, body, jar, agentOptions, method = 'GET', indicies = true }: WebscrapeOptions): OptionsObject {
	const options: OptionsObject = { uri, jar, method };

	options.headers = Object.assign({}, BASE_OPTIONS.headers, headers);
	if (query !== undefined) {
		options.qs = query;
		options.qsStringifyOptions = {
			arrayFormat: indicies ? 'indicies' : 'repeat' // the documentation on this is terrible
		};
	}

	if (agentOptions) {
		options.agentOptions = agentOptions;
	}

	// TODO: this logic may change later, since it is not obvious
	if (body !== undefined) {
		const headers = options.headers || {};
		const contentTypeSet = Object.keys(headers)
			.map((key: string): KVPair => ({ key: key.toLowerCase(), value: String(headers[key]) }))
			.filter((pair: KVPair): boolean => pair.key === 'content-type');
		if (contentTypeSet.length === 1) {
			// since there is a content type, we assume this is not a HTTP form.
			// NOTE: as a result, the user must do encoding manually.
			options.json = contentTypeSet[0].value.toLowerCase().startsWith('application/json');
			options.body = body;
		} else {
			if (typeof body === 'string') {
				options.body = body;
			} else {
				options.form = body;
			}
		}
	}

	return options;
}

function determineFilename(uri: string, filename: string): Promise<string> {
	return new Promise<string>((resolve: (string) => void, reject: (Error) => void): void => {
		let baseFilename
		try {
			const pathname = url.parse(uri,true).pathname;
			const matchResult = pathname ? /[^/]+$/.exec(pathname) : null;
			baseFilename = matchResult ? matchResult[0] : 'unknown';
		} catch (err) {
			log(`WARNING Unable to determine base filename for ${uri}, using "unknown"`);
			baseFilename = 'unknown';
		}

		// why is this the first condition? because we may need baseFilename if filename is a folder
		if (!filename && !baseFilename) {
			return reject(new Error(`DOWNLOAD ${uri} - Filename not given and cannot determine base name`)); // TODO: Nicer error
		} else if (filename) {
			// if the filename is actually a folder that already exists, then download to the folder using the baseFilename
			fs.stat(filename, (err: ?Error, result: Stats): void => {
				try {
					if (err || !result.isDirectory()) {
						return resolve(filename); // just carry on using the filename
					} else {
						// we append the basefilename to the directory
						return resolve(path.join(filename, baseFilename));
					}
				} catch (e) {
					return reject(e);
				}
			});
		} else {
			// no filename, but we have a baseFilename
			return resolve(baseFilename);
		}

	});
}

export default {
	createCookieJar, betterRequest, streamRequest, constructError, constructResult, constructOptionsWithJar, determineFilename
};

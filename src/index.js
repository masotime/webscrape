// @flow strict
import fs from 'fs';

import lib, { type WebscrapeResult, type WebscrapeOptions, type OptionsObject } from './lib';
import { debuglog } from 'util';

const log = debuglog('webscrape');

const { createCookieJar, betterRequest, streamRequest, constructOptionsWithJar, constructError, constructResult, determineFilename } = lib;

function isOK(statusCode: number): boolean {
	const str = statusCode && statusCode.toString();
	return str && str.length === 3 && str.indexOf('2') === 0 || false;
}

type GetOptions = {|
	headers?: $PropertyType<WebscrapeOptions, 'headers'>,
	query?: $PropertyType<WebscrapeOptions, 'query'>,
	agentOptions?: $PropertyType<WebscrapeOptions, 'agentOptions'>,
	indicies?: $PropertyType<WebscrapeOptions, 'indicies'>,
|};

type PostOptions = {|
	headers?: $PropertyType<WebscrapeOptions, 'headers'>,
	query?: $PropertyType<WebscrapeOptions, 'query'>,
	body?: $PropertyType<WebscrapeOptions, 'body'>,
	agentOptions?: $PropertyType<WebscrapeOptions, 'agentOptions'>,
	indicies?: $PropertyType<WebscrapeOptions, 'indicies'>,
|};

type DownloadOptions = {|
	post?: $PropertyType<WebscrapeOptions, 'body'>,
	headers?: $PropertyType<WebscrapeOptions, 'headers'>,
	query?: $PropertyType<WebscrapeOptions, 'query'>,
	agentOptions?: $PropertyType<WebscrapeOptions, 'agentOptions'>,
	filename: string,
	indicies?: $PropertyType<WebscrapeOptions, 'indicies'>,
|};

type ScraperApi = {|
	get: (uri: string, GetOptions) => Promise<WebscrapeResult>,
	post: (uri: string, PostOptions) => Promise<WebscrapeResult>,
	download: (uri: string, DownloadOptions) => Promise<string>
|};

function extractBody(res: stream$Readable): Promise<string> {
	return new Promise((ok, fail) => {
		const chunks = [];
		res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
		res.on('end', () => {
			return ok(Buffer.concat(chunks).toString('utf8'));
		});	
		res.on('error', (err: Error) => {
			return fail(err);
		})
	});
}

// creates a closure instance of a scraper
function Scraper(): ScraperApi {

	const jar = createCookieJar();
	const constructOptions = (uri: string, {
		headers, query, body, method, agentOptions, indicies
	}: $Shape<WebscrapeOptions> = {} ): OptionsObject => constructOptionsWithJar(uri, {
		headers, query, body, method, agentOptions, indicies, jar
	});

	const get = (uri: string, { headers, query, agentOptions, indicies }: GetOptions = {} ): Promise<WebscrapeResult> => new Promise((resolve: (WebscrapeResult) => void, reject: (Error) => void): void => {
		const options = constructOptions(uri, { headers, query, agentOptions, indicies, method: 'GET' });
		return betterRequest(options, (err, resp, body) => {
			if (err) {
				return reject(err);
			} else if (resp && body !== undefined) {
				const bodyStr: string = body instanceof Buffer ? body.toString('utf8') : body;
				if (!isOK(resp.statusCode)) {
					return reject(constructError(options, resp, bodyStr));
				} else {
					return resolve(constructResult(resp, bodyStr));
				}
			} else {
				return reject(new Error('no response or body'))
			}
		});

	});

	const post = (uri: string, { headers, query, body, agentOptions, indicies } = {} ): Promise<WebscrapeResult> => new Promise( (resolve, reject) => {
		const options = constructOptions(uri, { headers, query, body, agentOptions, indicies, method: 'POST' });
		return betterRequest(options, function(err, resp, body) {
			if (err) {
				return reject(err);
			} else if (resp && body !== undefined) {
				const bodyStr: string = body instanceof Buffer ? body.toString('utf8') : body;
				if (!isOK(resp.statusCode)) {
					return reject(constructError(options, resp, bodyStr));
				} else {
					return resolve(constructResult(resp, bodyStr));
				}
			} else {
				return reject(new Error('no response or body'));
			}
		});
	});

	const download = function(uri: string, { post, headers, query, agentOptions, filename, indicies }: DownloadOptions = {}): Promise<string> {

		return determineFilename(uri, filename).then((downloadpath: string): Promise<string> => {
			log(`DOWNLOAD ${uri} to ${downloadpath}`);

			// TODO: This mechanic is awkward and a band-aid. Find a better syntax
			const method = post && typeof post === 'object' ? 'POST' : 'GET';
			const preOpts: WebscrapeOptions = { method, headers, query, agentOptions, indicies };
			if (method === 'POST') {
				preOpts.body = post;
			}

			// normal operation resumes
			const options = constructOptions(uri, preOpts);
			const writeStream = fs.createWriteStream(downloadpath);
			return streamRequest(options)
				.then(({ response, stream }): Promise<string> => new Promise((resolve, reject) => {
					if (!isOK(response.statusCode)) {
						extractBody(stream)
							.then((errorBody) => reject(constructError(options, response, errorBody)))
							.catch(() => reject(constructError(options, response, 'no-body-could-be-extracted')));
						return;
					}

					stream.on('error', (err) => reject(err));
					writeStream.on('error', function(err) {
						return reject(err);
					}).on('finish', function() {
						writeStream.close();
						return resolve(downloadpath);
					});

					stream.pipe(writeStream);
				}));

		});

	};

	return { get, post, download };
}

export default Scraper;

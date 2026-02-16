/* global describe, it, afterEach, before, after */
import assert from 'assert';
import Scraper from '../src/index';
import Promise from 'bluebird';
import fs from 'fs';
import mkdirp from 'mkdirp';
import path from 'path';
import app from './server';

Promise.promisifyAll(fs);
const mkdir = Promise.promisify(mkdirp);

async function deleteIfExists(...files) {
	return files.reduce( async (chain, file) => {
		try {
			await chain;
			const stat = await fs.statAsync(file);
			return stat.isDirectory() && await fs.rmdirAsync(file) || await fs.unlinkAsync(file);
		} catch (err) {
			// file probably doesn't exist, so we ignore
		}
	}, Promise.resolve());
}

describe('Scraper', () => {

	// MAYDO: Transpilation means that the function length cannot be properly tested
	const apis = [
		{ name: 'get', length: 2 },
		{ name: 'post', length: 2 },
		{ name: 'download', length: 2}
	];

	it('should return a scrape object', async () => {
		const scraper = Scraper();
		assert.equal(typeof scraper, 'object');
		apis.forEach(api => {
			assert.equal(typeof scraper[api.name], 'function');
		});
	});

	it('should be able to fetch Google\'s home page', async () => {
		const scraper = Scraper();
		const result = await scraper.get('https://www.google.com');
		assert.ok(result.body);
		assert.ok(result.body.includes('<title>Google</title>'));
	});

	it('should get a $ representation of Google\'s home page', async () => {
		const scraper = Scraper();
		const result = await scraper.get('https://www.google.com');
		assert.ok(result.$);
		assert.equal(result.$('title').text(), 'Google');
	});

	it('should be able to fetch a JSON response from Google\'s GEOCoding API', async () => {
		const query = {
			'address': '1600 Amphitheatre Parkway, Mountain View, CA',
			'sensor': 'false'
		};

		const scraper = Scraper();
		const result = await scraper.get('http://maps.googleapis.com/maps/api/geocode/json', { query });
		assert.ok(result.json);
	});

	describe('download', () => {
		const url = 'https://ajax.googleapis.com/ajax/libs/swfobject/2.2/swfobject.js';
		const innerpath = 'tempinnerfolder';
		const baseName = 'swfobject.js';
		const newName = 'differentswfobject.js';

		// yuck
		let server;
		let port;

		before((next) => {
			server = app.listen(() => {
				port = server.address().port;
				next();
			});
		});

		after(() => server.close());

		afterEach( async () => await deleteIfExists(baseName, newName, path.join(innerpath, baseName), innerpath));

		it('should be able to download the SWF object javascript library from Google\'s CDN', async() => {
			const scraper = Scraper();

			const downloadedName = await scraper.download(url);
			assert.equal(downloadedName, baseName);

			const contents = await fs.readFileAsync(downloadedName, { encoding: 'utf8' });
			assert.ok(contents.includes('SWFObject'));
		});

		it('should be able to download to the "inner" folder when that is used as the "target filename"', async () => {
			const scraper = Scraper();
			await mkdir(innerpath);

			const downloadedName = await scraper.download(url, { filename: innerpath });
			assert.equal(downloadedName, path.join(innerpath, baseName));

			const contents = await fs.readFileAsync(downloadedName, { encoding: 'utf8'});
			assert.ok(contents.includes('SWFObject'));
		});

		it('should be able to download the SWF object javascript library under a different name', async () => {
			const scraper = Scraper();

			const downloadedName = await scraper.download(url, { filename: newName });
			assert.equal(downloadedName, newName);

			const contents = await fs.readFileAsync(downloadedName, { encoding: 'utf8'});
			assert.ok(contents.includes('SWFObject'));
		});

		it('should be able to download using POST with URL encoded body', async () => {
			const scraper = Scraper();

			const downloadedName = await scraper.download(`http://127.0.0.1:${port}/download1`, {
				post: { one: '1', two: '2' },
				filename: newName
			});
			const contents = await fs.readFileAsync(downloadedName, { encoding: 'utf8' });
			assert.ok(contents.includes('SWFObject'));
		});

		it('should be able to download using POST with JSON encoded body', async () => {
			const scraper = Scraper();

			const downloadedName = await scraper.download(`http://127.0.0.1:${port}/download2`, {
				headers: { 'content-type': 'application/json' },
				post: { one: '1', two: '2' },
				filename: newName
			});
			const contents = await fs.readFileAsync(downloadedName, { encoding: 'utf8' });
			assert.ok(contents.includes('SWFObject'));
		});

		it('should NOT be able to download using POST with JSON encoded body if that is not supported by the server', async () => {
			const scraper = Scraper();

			try {
				await scraper.download(`http://127.0.0.1:${port}/download1`, {
					headers: { 'content-type': 'application/json' },
					post: { one: 1, two: 2 },
					filename: newName
				});
				assert.fail('An error should have been thrown');
			} catch (err) {
				assert(err);
			}
		});

	});

	describe('support for headers', () => {
		const tempfile = "testfile.txt";
		const headers = { Referer: 'nonsense' };
		const HEADER_DIAGNOSIS_URL = 'https://www.whatismybrowser.com/detect/what-http-headers-is-my-browser-sending';

		it('should be able to add a header that is sent in the HTTP request', async () => {
			const scraper = Scraper();
			const result = await scraper.get(HEADER_DIAGNOSIS_URL, { headers });
			const refererHeader = result.$('th').filter((_, cell) => result.$(cell).text().trim().toLowerCase() === 'referer');
			assert.ok(refererHeader.next().text().toLowerCase().includes('nonsense'));
		});

		it('should be able to download a file with the header sent in the HTTP request', async () => {
			const scraper = Scraper();
			const downloadedName = await scraper.download(HEADER_DIAGNOSIS_URL, { filename: tempfile, headers });
			const contents = await fs.readFileAsync(downloadedName, { encoding: 'utf8' });
			assert.ok(contents.includes('nonsense'));
		});

		it('should be able to read headers from the response', async () => {
			const scraper = Scraper();
			const { headers } = await scraper.get('https://www.instagram.com');

			assert.ok(headers['set-cookie']);
		});

		afterEach(async () => await deleteIfExists(tempfile));

	});

	describe('querystring support', () => {
		it('should use indices by default for arrays in query', async () => {
			const scraper = Scraper();
			const { json } = await scraper.get('https://postman-echo.com/get', {
				query: {
					test: [123,234]
				}
			});

			assert.equal(decodeURI(json.url), 'https://postman-echo.com/get?test[0]=123&test[1]=234');
		});

		it('should disable indicies if specified as false in options', async () => {
			const scraper = Scraper();
			const { json } = await scraper.get('https://postman-echo.com/get', {
				query: {
					test: [123,234]
				},
				indicies: false
			});

			assert.equal(decodeURI(json.url), 'https://postman-echo.com/get?test=123&test=234');
		});
	});

});

const { readFile, stat } = require('fs').promises
const httpie = require('httpie')
const path = require('path')

const CF_PREFIX = 'https://api.cloudflare.com/client/v4/accounts'

const envToPropLegacy = {
	CF_AUTH_EMAIL: 'authEmail',
	CF_AUTH_KEY: 'authKey',
	CF_ACCOUNT_ID: 'accountId',
	CF_API_TOKEN: 'apiToken',
	CF_NAMESPACE_ID: 'namespaceId',
}
const envToProp = {
	CLOUDFLARE_AUTH_EMAIL: 'authEmail',
	CLOUDFLARE_AUTH_KEY: 'authKey',
	CLOUDFLARE_ACCOUNT_ID: 'accountId',
	CLOUDFLARE_API_TOKEN: 'apiToken',
	CLOUDFLARE_NAMESPACE_ID: 'namespaceId',
}

const alwaysRequired = [ 'accountId', 'namespaceId' ]
const oneOfIsRequired = [ 'authKey', 'apiToken' ]

const initialize = moreRequired => {
	const opts = Object
		.keys(envToPropLegacy)
		.reduce((map, key) => {
			if (process.env[key]) {
				map[envToPropLegacy[key]] = process.env[key]
			}
			return map
		}, {})
	for (const key in envToProp) {
		if (process.env[key]) opts[envToProp[key]] = process.env[key]
	}
	const required = [ ...alwaysRequired, ...(moreRequired || []) ]
	if (!required.every(key => opts[key])) {
		console.error(`The following options must be set as environment variables or parameters: ${required.join(', ')}`)
		process.exit(1)
	}
	if (!oneOfIsRequired.some(key => opts[key])) {
		console.error(`One of the following options must be set as an environment variable or parameter: ${oneOfIsRequired.join(', ')}`)
		process.exit(1)
	}
	opts.authHeaders = {}
	if (opts.apiToken) opts.authHeaders['Authorization'] = `Bearer ${opts.apiToken}`
	else if (opts.authKey && opts.authEmail) {
		opts.authHeaders['X-Auth-Key'] = opts.authKey
		opts.authHeaders['X-Auth-Email'] = opts.authEmail
	}
	return opts
}

const handleHttpError = message => response => {
	console.error(message + ':', response.statusCode, response.data)
	process.exit(1)
}

/*
https://api.cloudflare.com/#workers-kv-namespace-list-a-namespace-s-keys
GET accounts/:account_identifier/storage/kv/namespaces/:namespace_identifier/keys
curl -X GET "https://api.cloudflare.com/client/v4/accounts/01a7362d577a6c3019a474fd6f485823/storage/kv/namespaces/0f2ac74b498b48028cb68387c421e279/keys?limit=1000&cursor=6Ck1la0VxJ0djhidm1MdX2FyDGxLKVeeHZZmORS_8XeSuhz9SjIJRaSa2lnsF01tQOHrfTGAP3R5X1Kv5iVUuMbNKhWNAXHOl6ePB0TUL8nw&prefix=My-Prefix" \
     -H "X-Auth-Email: user@example.com" \
     -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41"
*/
const listKeys = async ({ prefix, cursor, page = 1 }) => {
	const { accountId, authHeaders, namespaceId } = initialize()
	let url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/keys?limit=1000`
	if (cursor) {
		url += `&cursor=${cursor}`
	}
	if (prefix) {
		url += `&prefix=${prefix}`
	}
	const results = await httpie.send('GET', url, {
		headers: {
			...authHeaders,
			'Content-Type': 'application/json',
		},
	}).catch(handleHttpError('Error while listing Cloudflare KV entries'))

	const keys = (results.data.result || []).map(item => item.name)
	if (results.data && results.data.result_info && results.data.result_info.cursor) {
		const more = await listKeys({
			prefix,
			page: page + 1,
			cursor: results.data.result_info.cursor,
		})
		keys.push(...more)
	}
	return keys
}

/*
https://api.cloudflare.com/#workers-kv-namespace-delete-key-value-pair
DELETE accounts/:account_identifier/storage/kv/namespaces/:namespace_identifier/bulk
curl -X DELETE "https://api.cloudflare.com/client/v4/accounts/01a7362d577a6c3019a474fd6f485823/storage/kv/namespaces/0f2ac74b498b48028cb68387c421e279/bulk" \
     -H "X-Auth-Email: user@example.com" \
     -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41" \
     -H "Content-Type: application/json" \
     --data '["My-Key"]'
*/
const removeItems = async ({ prefix, files }) => {
	const { accountId, authHeaders, namespaceId } = initialize()
	const url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`
	for (const file of files) {
		console.log('-', (prefix || '') + file)
	}
	await httpie.send('DELETE', url, {
		headers: {
			...authHeaders,
			'Content-Type': 'application/json',
		},
		body: files.map(file => (prefix || '') + file),
	}).catch(handleHttpError('Error while removing Cloudflare KV entries'))
}

/*
https://developers.cloudflare.com/api/operations/workers-kv-namespace-write-multiple-key-value-pairs
PUT /client/v4/accounts/{account_identifier}/storage/kv/namespaces/{namespace_identifier}/bulk
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/01a7362d577a6c3019a474fd6f485823/storage/kv/namespaces/0f2ac74b498b48028cb68387c421e279/bulk" \
     -H "X-Auth-Email: user@example.com" \
     -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41" \
     -H "Content-Type: application/json" \
     --data '[{"key":"My-Key","value":"Some string","expiration":1578435000,"expiration_ttl":300,"metadata":{"someMetadataKey":"someMetadataValue"},"base64":false}]'
The entire request size must be 100 megabytes or less.
*/
const MAX_PAYLOAD = 99000000 // 100 but with a little space
const putItems = async ({ prefix, folder, files }) => {
	const detailedFiles = await Promise.all(files.map(async file => {
		file.size = (await stat(path.join(folder, file.original))).size
		if (file.size >= MAX_PAYLOAD) {
			console.error('The maximum file size is 100 megabytes.', file)
			process.exit(1)
		}
		return file
	}))
	const splitFiles = detailedFiles
		.reduce((lists, file) => {
			const lastListSize = lists[lists.length - 1].size
			if ((lastListSize + file.size) >= MAX_PAYLOAD) {
				lists.push({ size: 0, files: [] })
			}
			lists[lists.length - 1].files.push(file)
			lists[lists.length - 1].size += file.size
			return lists
		}, [{ size: 0, files: [] }])

	const { accountId, authHeaders, namespaceId } = initialize()
	const url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`
	for (const { files } of splitFiles) {
		for (const file of files) {
			console.log('-', `${prefix || ''}${file.original}`)
		}
		const readFiles = await Promise.all(files.map(async file => {
			file.value = await readFile(file.fullPath, 'base64')
			return file
		}))
		await httpie.send('PUT', url, {
			headers: {
				...authHeaders,
				'Content-Type': 'application/json',
			},
			body: readFiles
				.map(({ key, value }) => ({
					key: `${prefix || ''}${key}`,
					value,
					base64: true,
				})),
		}).catch(handleHttpError('Error while writing Cloudflare KV entries'))
	}
}

/*
https://developers.cloudflare.com/api/operations/workers-kv-namespace-read-key-value-pair
GET /client/v4/accounts/{account_identifier}/storage/kv/namespaces/{namespace_identifier}/values/{key_name}
curl -X GET "https://api.cloudflare.com/client/v4/accounts/01a7362d577a6c3019a474fd6f485823/storage/kv/namespaces/0f2ac74b498b48028cb68387c421e279/values/My-Key" \
     -H "X-Auth-Email: user@example.com" \
     -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41"
*/
const getItem = async ({ key }) => {
	const { accountId, authHeaders, namespaceId } = initialize()
	const url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`
	const results = await httpie.send('GET', url, {
		headers: {
			...authHeaders,
			'Content-Type': 'application/json',
		},
	})
	return results.data
}

/*
https://api.cloudflare.com/#workers-kv-namespace-write-key-value-pair
PUT accounts/:account_identifier/storage/kv/namespaces/:namespace_identifier/values/:key_name?expiration=:expiration&expiration_ttl=:expiration_ttl
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/01a7362d577a6c3019a474fd6f485823/storage/kv/namespaces/0f2ac74b498b48028cb68387c421e279/values/My-Key?expiration=1578435000&expiration_ttl=300" \
     -H "X-Auth-Email: user@example.com" \
     -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41" \
     -H "Content-Type: text/plain" \
     --data '"Some Value"'
*/
const putItem = async ({ key, value }) => {
	const { accountId, authHeaders, namespaceId } = initialize()
	const url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`
	const results = await httpie.send('PUT', url, {
		headers: {
			...authHeaders,
			'Content-Type': 'application/json',
		},
		body: value,
	}).catch(handleHttpError('Error while upserting single item'))
	return results.data
}

module.exports = {
	getFileHashes: async ({ prefix, hash }) => {
		try {
			const fileHashes = await getItem({
				key: `${prefix || ''}${hash || 'hashes'}`,
			})
			return fileHashes
				? JSON.parse(fileHashes)
				: {}
		} catch (err) {
			if (err.statusCode === 404) {
				return {}
			}
			throw err
		}
	},
	putFileHashes: async ({ prefix, hash, hashMap }) => {
		await putItem({
			key: `${prefix || ''}${hash || 'hashes'}`,
			value: hashMap,
		})
	},
	listKeys: async ({ prefix }) => {
		return listKeys({ prefix })
	},
	putItems: async ({ prefix, folder, files }) => {
		return putItems({ prefix, folder, files })
	},
	removeItems: async ({ prefix, files }) => {
		return removeItems({ prefix, files })
	},
}

const { readFile, stat } = require('fs').promises
const httpie = require('httpie')
const path = require('path')
const promiseAll = require('p-all')

const CF_PREFIX = 'https://api.cloudflare.com/client/v4/accounts'

const envToProp = {
	CF_AUTH_EMAIL: 'authEmail',
	CF_AUTH_KEY: 'authKey',
	CF_ACCOUNT_ID: 'accountId',
	CF_NAMESPACE_ID: 'namespaceId'
}

const alwaysRequired = [ 'authEmail', 'authKey', 'accountId', 'namespaceId' ]

const initialize = moreRequired => {
	const opts = Object
		.keys(envToProp)
		.reduce((map, key) => {
			if (process.env[key]) {
				map[envToProp[key]] = process.env[key]
			}
			return map
		}, {})
	const required = [ ...alwaysRequired, ...(moreRequired || []) ]
	if (!required.every(key => opts[key])) {
		console.error(`The following options must be set as environment variables or parameters: ${required.join(', ')}`)
		process.exit(1)
	}
	return opts
}

/*
https://api.cloudflare.com/#workers-kv-namespace-list-a-namespace-s-keys
GET accounts/:account_identifier/storage/kv/namespaces/:namespace_identifier/keys
curl -X GET "https://api.cloudflare.com/client/v4/accounts/01a7362d577a6c3019a474fd6f485823/storage/kv/namespaces/0f2ac74b498b48028cb68387c421e279/keys?limit=1000&cursor=6Ck1la0VxJ0djhidm1MdX2FyDGxLKVeeHZZmORS_8XeSuhz9SjIJRaSa2lnsF01tQOHrfTGAP3R5X1Kv5iVUuMbNKhWNAXHOl6ePB0TUL8nw&prefix=My-Prefix" \
     -H "X-Auth-Email: user@example.com" \
     -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41"
*/
const listKeys = async ({ prefix, cursor, page = 1 }) => {
	const { accountId, authEmail, authKey, namespaceId } = initialize()
	let url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/keys?limit=1000`
	if (cursor) {
		url += `&cursor=${cursor}`
	}
	if (prefix) {
		url += `&prefix=${prefix}`
	}
	const results = await httpie.send('GET', url, {
		headers: {
			'X-Auth-Email': authEmail,
			'X-Auth-Key': authKey
		}
	}).catch(error => error)

	if (!results.data || !results.data.success) {
		console.log('Error while listing Cloudflare KV entries:')
		console.error(results.data || results)
		process.exit(1)
	}

	const keys = (results.data.result || []).map(item => item.name)
	if (results.data && results.data.result_info && results.data.result_info.cursor) {
		const more = await listKeys({
			prefix,
			page: page + 1,
			cursor: results.data.result_info.cursor
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
	const { accountId, authEmail, authKey, namespaceId } = initialize()
	const url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`
	for (const file of files) {
		console.log('-', file)
	}
	const results = await httpie.send('DELETE', url, {
		headers: {
			'X-Auth-Email': authEmail,
			'X-Auth-Key': authKey,
			'Content-Type': 'application/json'
		},
		body: files
	}).catch(error => error)

	if (!results.data || !results.data.success) {
		console.log('Error while removing Cloudflare KV entries:')
		console.error(results.data || results)
		process.exit(1)
	}
}

/*
https://api.cloudflare.com/#workers-kv-namespace-write-multiple-key-value-pairs
PUT accounts/:account_identifier/storage/kv/namespaces/:namespace_identifier/bulk
curl -X PUT "https://api.cloudflare.com/client/v4/accounts/01a7362d577a6c3019a474fd6f485823/storage/kv/namespaces/0f2ac74b498b48028cb68387c421e279/bulk" \
     -H "X-Auth-Email: user@example.com" \
     -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41" \
     -H "Content-Type: application/json" \
     --data '[{"key":"My-Key","value":"Some string","expiration":1578435000,"expiration_ttl":300,"metadata":{"someMetadataKey":"someMetadataValue"},"base64":false}]'
The entire request size must be 100 megabytes or less.
*/
const MAX_PAYLOAD = 99000000 // 100 but with a little space
const putItems = async ({ prefix, folder, files }) => {
	const detailedFiles = await promiseAll(files.map(file => async () => {
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
		}, [ { size: 0, files: [] } ])

	const { accountId, authEmail, authKey, namespaceId } = initialize()
	const url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/bulk`
	for (const { files } of splitFiles) {
		for (const file of files) {
			console.log('-', file.original)
		}
		const readFiles = await promiseAll(files.map(file => async () => {
			file.value = await readFile(file.fullPath, 'base64')
			return file
		}))
		const results = await httpie.send('PUT', url, {
			headers: {
				'X-Auth-Email': authEmail,
				'X-Auth-Key': authKey,
				'Content-Type': 'application/json'
			},
			body: readFiles
				.map(({ key, value }) => ({
					key: `${prefix || ''}${key}`,
					value,
					base64: true
				}))
		})
		if (!results.data || !results.data.success) {
			console.log('Error while writing Cloudflare KV entries:')
			console.error(results.data || results)
			process.exit(1)
		}
	}
}

/*
https://api.cloudflare.com/#workers-kv-namespace-read-key-value-pair
GET accounts/:account_identifier/storage/kv/namespaces/:namespace_identifier/values/:key_name
curl -X GET "https://api.cloudflare.com/client/v4/accounts/01a7362d577a6c3019a474fd6f485823/storage/kv/namespaces/0f2ac74b498b48028cb68387c421e279/values/My-Key" \
     -H "X-Auth-Email: user@example.com" \
     -H "X-Auth-Key: c2547eb745079dac9320b638f5e225cf483cc5cfdda41"
*/
const getItem = async ({ prefix, key }) => {
	const { accountId, authEmail, authKey, namespaceId } = initialize()
	const url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`
	const results = await httpie.send('GET', url, {
		headers: {
			'X-Auth-Email': authEmail,
			'X-Auth-Key': authKey,
			'Content-Type': 'application/json'
		}
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
	const { accountId, authEmail, authKey, namespaceId } = initialize()
	const url = `${CF_PREFIX}/${accountId}/storage/kv/namespaces/${namespaceId}/values/${key}`
	const results = await httpie.send('PUT', url, {
		headers: {
			'X-Auth-Email': authEmail,
			'X-Auth-Key': authKey,
			'Content-Type': 'application/json'
		},
		body: value
	})
	return results.data
}

module.exports = {
	getFileHashes: async ({ prefix, hash }) => {
		let actualPrefix = prefix || ''
		if (hash) {
			actualPrefix = `${actualPrefix}:${hash}`
		}
		const fileHashes = await getItem({
			key: `${prefix || ''}${hash || 'hashes'}`
		})
		return fileHashes
			? JSON.parse(fileHashes)
			: {}
	},
	putFileHashes: async ({ prefix, hash, hashMap }) => {
		let actualPrefix = prefix || ''
		if (hash) {
			actualPrefix = `${actualPrefix}:${hash}`
		}
		await putItem({
			key: `${prefix || ''}${hash || 'hashes'}`,
			value: hashMap
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
	}
}

#!/usr/bin/env node

const { promisify } = require('util')
const { getLocalFileList } = require('./src/files.js')
const worker = require('./src/worker.js')
const manyFileHashes = promisify(require('many-file-hashes'))
const pkg = require('./package.json')
const sade = require('sade')

const logger = (prefix, list) => `${prefix} ${list.length} file${list.length === 0 || list.length > 1 ? 's' : ''}${list.length === 0 ? '.' : ':'}`

sade('sync-to-kv <folder>', true)
	.version(pkg.version)
	.describe('Push the contents of a folder to Cloudflare KV.')
	.option('-i, --ignore', 'Ignore one or more files (uses glob syntax).')
	.option('-p, --prefix', 'Optional overall Cloudflare KV prefix.')
	.option('-f, --file', 'Prefix for files (default "file:").')
	.option('-h, --hash', 'Name of hash entry (default "hashes").')
	.option('-d, --dryrun', 'Do not update Cloudflare KV entries.')
	.example(`./site -c -i='**/*.js' -i='*.md'`)
	.action(async (folder, opts) => {
		const localFiles = await getLocalFileList(folder, opts)
		const fileHashes = (await manyFileHashes({
			files: localFiles,
			cwd: folder,
		})).map(file => {
			file.key = encodeURIComponent(file.original)
			return file
		})
		const kvFileHashes = await worker.getFileHashes(opts)

		const filesToUpload = fileHashes
			.filter(({ key, hash }) => kvFileHashes[key] !== hash)
		const fileKeysToRemove = Object
			.keys(kvFileHashes)
			.filter(key => !fileHashes.find(file => file.key === key))

		if (opts.dryrun) {
			console.log('(Dry run, no files will be modified.)')
			console.log(logger('Upload', filesToUpload))
			for (const file of filesToUpload) { console.log('-', file.original) }
			console.log(logger('Remove', fileKeysToRemove))
			for (const file of fileKeysToRemove) { console.log('-', decodeURIComponent(file)) }
		} else {
			console.log(logger('Uploading', filesToUpload))
			await worker.putItems({ folder, files: filesToUpload, ...opts })

			console.log(logger('Removing', fileKeysToRemove))
			await worker.removeItems({ files: fileKeysToRemove, ...opts })

			console.log('Updating file hash record...')
			await worker.putFileHashes({
				hashMap: fileHashes
					.reduce((map, { key, hash }) => {
						map[key] = hash
						return map
					}, {}),
				...opts,
			})
		}
	})
	.parse(process.argv)
	.catch(error => {
		console.error('Runtime error:', error)
	})

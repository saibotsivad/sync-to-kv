const { promisify } = require('util')
const { stat } = require('fs').promises
const glob = promisify(require('glob'))
const path = require('path')

const getLocalFileList = async (folder, opts) => {
	const getMatchingFiles = async filters => Promise
		.all(filters.map(filter => glob(filter, { cwd: folder })))
		.then(lists => lists.flat())

	const onlyFiles = async files => Promise
		.all(files.map(file => stat(path.join(folder, file)).then(s => !s.isDirectory() && file)))
		.then(files => files.filter(Boolean))

	const ignore = await getMatchingFiles(
		Array.isArray(opts.ignore)
			? opts.ignore
			: (opts.ignore ? [ opts.ignore ] : []),
	)
	const folderList = await glob('**', { cwd: folder })
	return onlyFiles(folderList.filter(file => !ignore.includes(file)))
}

module.exports = { getLocalFileList }

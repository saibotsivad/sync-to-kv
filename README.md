# sync-to-kv

Push the contents of a folder to Cloudflare KV.

If you have a nice little static website, and you want to host the files somewhere, you can shove them in CFKV to be accessed by a small fast Worker.

## Install

The usual way (global for CLI access):

```shell
npm install -g sync-to-kv
```

## How to Use

You will need the KV "Namespace ID", and some environment variables:

* `CF_ACCOUNT_ID` - Your Cloudflare account id.
* `CF_NAMESPACE_ID` - The "Namespace ID" of that KV store.
* Either this one (recommended):
  * `CF_API_TOKEN` - A [generated API token](https://dash.cloudflare.com/profile/api-tokens) with Workers/KV storage permissions.
* Or this one:
  * `CF_AUTH_EMAIL` - Your Cloudflare account email address.
  * `CF_AUTH_KEY` - Your global API key.

(Note: the `CLOUDFLARE_` prefix is also supported.)

Then you simply run the command like this:

```bash
sync-to-kv ./path/to/folder
```

## Additional Options

You can run `--help` for more details, but the flags you can pass in are:

* `-i`, `--ignore` : Ignore one or more files, using glob syntax. Example `-i='**/*.test.js'`.
* `-p`, `--prefix` : This is a prefix used for partitioning groups of KV entries within the same store. E.g. site A may use `-p='a:'` while site B may use `-p='b:'`.
* `-f`, `--file` *(default `file:`)* : Prefix used for all file entries, e.g. a file `index.html` with the default prefix (`file:`) would be stored with a key `file:index.html`.
* `-h`, `--hash` *(default `hashes`)* : Name used to store the dictionary hash map of key names to hashes, which is used to improve upload time.
* `-d`, `--dryrun` : Just print out what would have been updated or removed, but do not actually update KV.

## Examples

If you have a folder like `site` and you want to exclude all `*.test.js` files, you would write something like:

```bash
sync-to-kv ./site -i '**/*.test.js'
```

If you have multiple sites in one KV store, it might be good to store them by domain name, so your `--prefix` would be the domain:

```bash
sync-to-kv ./site -p site.com
```

Here's a longer example with many flags:

```bash
sync-to-kv ./site \
  -i '**/*.test.js' \
  -i '**/*.md' \
  -i '.DS_Store' \
  -p site.com \
  -f 'bin:' \
  -h 'hashmap'
```

## License

Published and released under the [Very Open License](http://veryopenlicense.com).

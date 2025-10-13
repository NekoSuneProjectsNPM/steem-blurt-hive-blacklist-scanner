# steem-blurt-hive-blacklist-scanner


A tiny npm package / CLI to scan usernames against public blacklists for Blurt and Hive (and placeholder Steemit - currently no central blacklist).


## Features
- Fetches Blurt blacklist from a configurable URL (default: https://coal.blurtwallet.com/)
- Fetches Hive blacklist from https://spaminator.me/api/bl/all.json
- Normalises usernames and checks single username or list (file or stdin)
- CLI and JS API


## Install (local dev)


```bash
npm install node-fetch@2 minimist
# Place index.js somewhere and `npm link` to test CLI
npm link
sbhs-scan --help
```


## CLI examples


Check single user:
```
sbhs-scan --user anikkhan16
```


Check multiple users from newline file:
```
sbhs-scan --file users.txt
```


Output formats: plain (default) or json:
```
sbhs-scan --file users.txt --format json
```


## JS API


```js
const scanner = require('./index');
await scanner.init();
const report = await scanner.checkUsers(['anikkhan16','akomo','a-0-0']);
console.log(report);
```
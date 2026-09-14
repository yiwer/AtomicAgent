import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const base=JSON.parse(readFileSync(process.argv[2],'utf8'));
const matches=/^sha256:[a-f0-9]{64}$/.test(base.image??'') && base.recipe===createHash('sha256').update(readFileSync('deploy/Dockerfile.app')).digest('hex') && ['package.json','package-lock.json'].every(name=>
  base.packages?.[name]===createHash('sha256').update(readFileSync(name)).digest('hex'));
process.exitCode=matches?0:1;

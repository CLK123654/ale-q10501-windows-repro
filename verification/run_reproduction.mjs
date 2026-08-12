import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const repo=path.resolve(process.argv[2]??'.');
const taskRoot=path.join(repo,'task');
const runtime=process.env.PLAYWRIGHT_RUNTIME_INPUT;
const assert=(value,message)=>{if(!value)throw new Error(message);};
assert(runtime,'PLAYWRIGHT_RUNTIME_INPUT is required');
const run=(command,args,options={})=>{const result=spawnSync(command,args,{encoding:'utf8',windowsHide:true,timeout:180000,...options});if(result.error)throw result.error;return result;};
function extract(archive,dest){const result=run('pwsh.exe',['-NoProfile','-NonInteractive','-Command','Expand-Archive -LiteralPath $env:SOURCE_ZIP -DestinationPath $env:DEST_DIR -Force'],{env:{...process.env,SOURCE_ZIP:archive,DEST_DIR:dest}});assert(result.status===0,result.stderr||result.stdout);}
async function files(base,current=base){const out=[];for(const entry of await fs.readdir(current,{withFileTypes:true})){const full=path.join(current,entry.name);if(entry.isDirectory())out.push(...await files(base,full));else out.push(path.relative(base,full).split(path.sep).join('/'));}return out.sort();}
async function digestTree(base){const hash=crypto.createHash('sha256');for(const rel of await files(base))hash.update(rel).update('\0').update(await fs.readFile(path.join(base,...rel.split('/')))).update('\0');return hash.digest('hex');}
async function compare(actual,expected){const actualFiles=await files(actual),expectedFiles=await files(expected);assert(JSON.stringify(actualFiles)===JSON.stringify(expectedFiles),'Reference file tree differs');for(const rel of expectedFiles)assert((await fs.readFile(path.join(actual,...rel.split('/')))).equals(await fs.readFile(path.join(expected,...rel.split('/')))),`Reference file differs:${rel}`);}
async function prepare(label,solved=true){
  const base=await fs.mkdtemp(path.join(os.tmpdir(),`登录 发布 ${label} `));
  const input=path.join(base,'input');
  const reference=path.join(base,'reference');
  await fs.mkdir(input);await fs.mkdir(reference);
  extract(path.join(taskRoot,'输入数据包.zip'),input);
  extract(path.join(taskRoot,'reference.zip'),reference);
  const inputRoot=path.join(input,'input_data');
  await fs.cp(path.join(runtime,'node_modules'),path.join(inputRoot,'node_modules'),{recursive:true});
  if(solved)await fs.copyFile(path.join(reference,'output','tests','login-webauthn-fallback.spec.ts'),path.join(inputRoot,'starter','login-webauthn-fallback.spec.ts'));
  return{base,inputRoot,referenceOutput:path.join(reference,'output'),output:path.join(input,'output')};
}
function execute(inputRoot){return run(process.execPath,['tools/run-task.mjs'],{cwd:inputRoot});}
function parseCsv(text){const rows=[];let row=[],field='',quoted=false;for(let index=0;index<text.length;index+=1){const character=text[index];if(quoted){if(character==='"'&&text[index+1]==='"'){field+='"';index+=1;}else if(character==='"')quoted=false;else field+=character;}else if(character==='"')quoted=true;else if(character===','){row.push(field);field='';}else if(character==='\n'){row.push(field.replace(/\r$/,''));if(row.some(value=>value!==''))rows.push(row);row=[];field='';}else field+=character;}if(field||row.length){row.push(field);rows.push(row);}const [head,...body]=rows;return body.map(values=>Object.fromEntries(head.map((key,index)=>[key,values[index]??''])));}

const clean=[];
let baselineOutputDigest='';
let crlfSource='';
for(const label of ['中文 空格 目录一','中文 空格 目录二']){
  const room=await prepare(label);
  const before=await digestTree(room.inputRoot);
  let first='';
  for(let pass=1;pass<=2;pass+=1){
    const result=execute(room.inputRoot);
    assert(result.status===0,`${label} run ${pass} failed:${result.stderr||result.stdout}`);
    await compare(room.output,room.referenceOutput);
    const now=await digestTree(room.output);
    if(first)assert(now===first,`${label} repeated run drift`);else first=now;
  }
  if(!baselineOutputDigest)baselineOutputDigest=first;
  if(!crlfSource)crlfSource=await fs.readFile(path.join(room.output,'reports','auth_flow_matrix.csv'),'utf8');
  assert(await digestTree(room.inputRoot)===before,`${label} input changed`);
  clean.push({directory_label:label,process_runs:2,input_unchanged:true,reference_full_match:true,output_digest:first});
  await fs.rm(room.base,{recursive:true,force:true});
}

const mutation=await prepare('有效变化');
const localePath=path.join(mutation.inputRoot,'app','locales','es-ES.json');
const locale=JSON.parse(await fs.readFile(localePath,'utf8'));
const priorText=locale.password_invalid;
locale.password_invalid='Revisa el correo y la contraseña.';
await fs.writeFile(localePath,JSON.stringify(locale,null,2)+'\n');
const changed=execute(mutation.inputRoot);
assert(changed.status===0,changed.stderr||changed.stdout);
const localeRows=parseCsv(await fs.readFile(path.join(mutation.output,'reports','locale_copy_findings.csv'),'utf8'));
assert(localeRows.find(row=>row.locale==='es-ES'&&row.copy_key==='password_invalid')?.observed_text===locale.password_invalid,'valid locale change was not observed');
assert(await digestTree(mutation.output)!==baselineOutputDigest,'valid locale change did not change business output');
await fs.rm(mutation.base,{recursive:true,force:true});

const missing=await prepare('缺少语言包');
await fs.unlink(path.join(missing.inputRoot,'app','locales','zh-CN.json'));
const missingResult=execute(missing.inputRoot);
assert(missingResult.status!==0&&!(await fs.stat(missing.output).catch(()=>null)),'missing locale did not close without output');
await fs.rm(missing.base,{recursive:true,force:true});
const unfinished=await prepare('未完成脚本',false);
const unfinishedResult=execute(unfinished.inputRoot);
assert(unfinishedResult.status!==0&&!(await fs.stat(unfinished.output).catch(()=>null)),'unfinished script did not close without output');
await fs.rm(unfinished.base,{recursive:true,force:true});

const crlfPath=path.join(os.tmpdir(),`playwright-crlf-${process.pid}.csv`);
const crlfText=crlfSource.replace(/\r?\n/g,'\r\n');
await fs.writeFile(crlfPath,crlfText,'utf8');
const require=createRequire(path.join(runtime,'package.json'));
const { chromium }=require('playwright');
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
await page.setContent('<input id="csv" type="file">');
await page.locator('#csv').setInputFiles(crlfPath);
const browserRead=await page.locator('#csv').evaluate(async input=>{const text=await input.files[0].text();const lines=text.split(/\r\n/).filter(Boolean);return{crlf:text.includes('\r\n'),rows:lines.length-1,columns:lines[0].split(',').length};});
await browser.close();
await fs.unlink(crlfPath);
assert(browserRead.crlf&&browserRead.rows===6&&browserRead.columns===12,'Chromium did not read CRLF CSV as expected');

const version=run(process.execPath,[path.join(runtime,'node_modules','playwright','cli.js'),'--version']);
assert(version.status===0,'Playwright version unavailable');
console.log(JSON.stringify({result:'PASS',platform:process.platform,architecture:process.arch,node_version:process.version,playwright_version:version.stdout.trim(),clean_directories:clean,valid_input_change:{changed_field:'es-ES.password_invalid',from:priorText,to:locale.password_invalid,business_result_changed:true,assertions_passed:true},invalid_inputs:[{case:'missing_locale',return_code:missingResult.status,no_residual_output:true},{case:'unfinished_script',return_code:unfinishedResult.status,no_residual_output:true}],crlf_boundary:{chromium_file_api_read:true,records:browserRead.rows,columns:browserRead.columns,extra_records:0},real_playwright_chromium_executed:true},null,2));

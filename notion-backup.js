#!/usr/bin/env node
/* eslint no-await-in-loop: 0 */

let axios = require('axios')
  , extract = require('extract-zip')
  , { retry } = require('async')
  , { createWriteStream } = require('fs')
  , { mkdir, rm, readdir } = require('fs/promises')
  , { join } = require('path')
  , notionAPI = 'https://www.notion.so/api/v3'
  , { NOTION_TOKEN, NOTION_FILE_TOKEN, NOTION_SPACE_ID } = process.env
  , client = axios.create({
      baseURL: notionAPI,
      headers: {
        Cookie: `token_v2=${NOTION_TOKEN}; file_token=${NOTION_FILE_TOKEN}`
      },
    })
  , die = (str) => {
      console.error(str);
      process.exit(1);
    }
;

if (!NOTION_TOKEN || !NOTION_SPACE_ID) {
  die(`Need to have NOTION_TOKEN, NOTION_FILE_TOKEN and NOTION_SPACE_ID defined in the environment.
See https://medium.com/@arturburtsev/automated-notion-backups-f6af4edc298d for
notes on how to get that information.`);
}

async function post (endpoint, data) {
  return client.post(endpoint, data);
}

async function sleep (seconds) {
  return new Promise((resolve) => {
    setTimeout(resolve, seconds * 1000);
  });
}

// formats: markdown, html
async function exportFromNotion (format) {
  try {
    let { data: { taskId } } = await post('enqueueTask', {
      task: {
        eventName: 'exportSpace',
        request: {
          spaceId: NOTION_SPACE_ID,
          exportOptions: {
            exportType: format,
            timeZone: 'America/New_York',
            locale: 'en',
          },
        },
      },
    });
    console.warn(`Enqueued task ${taskId}`);
    let failCount = 0
      , exportURL
    ;
    while (true) {
      if (failCount >= 5) break;
      await sleep(10);
      let { data: { results: tasks } } = await retry(
        { times: 3, interval: 2000 },
        async () => post('getTasks', { taskIds: [taskId] })
      );
      let task = tasks.find(t => t.id === taskId);
      // console.warn(JSON.stringify(task, null, 2)); // DBG
      if (!task) {
        failCount++;
        console.warn(`No task, waiting.`);
        continue;
      }
      if (!task.status) {
        failCount++;
        console.warn(`No task status, waiting. Task was:\n${JSON.stringify(task, null, 2)}`);
        continue;
      }
      if (task.state === 'in_progress') console.warn(`Pages exported: ${task.status.pagesExported}`);
      if (task.state === 'failure') {
        failCount++;
        console.warn(`Task error: ${task.error}`);
        continue;
      }
      if (task.state === 'success') {
        exportURL = task.status.exportURL;
        break;
      }
    }
    let res = await client({
      method: 'GET',
      url: exportURL,
      responseType: 'stream'
    });
    let stream = res.data.pipe(createWriteStream(join(process.cwd(), `${format}.zip`)));
    await new Promise((resolve, reject) => {
      stream.on('close', resolve);
      stream.on('error', reject);
    });
  }
  catch (err) {
    die(err);
  }
}

async function run () {
  let cwd = process.cwd()
    , mdDir = join(cwd, 'markdown')
    , mdFile = join(cwd, 'markdown.zip')
    , htmlDir = join(cwd, 'html')
    , htmlFile = join(cwd, 'html.zip')
  ;
  await exportFromNotion('markdown');
  await rm(mdDir, { recursive: true, force: true });
  await mkdir(mdDir, { recursive: true });
  await extract(mdFile, { dir: mdDir });
  await extractInnerZip(mdDir);
  await exportFromNotion('html');
  await rm(htmlDir, { recursive: true, force: true });
  await mkdir(htmlDir, { recursive: true });
  await extract(htmlFile, { dir: htmlDir });
  await extractInnerZip(htmlDir);
}

async function extractInnerZip (dir) {
  let files = (await readdir(dir)).filter(fn => /Part-\d+\.zip$/i.test(fn));
  for (let file of files) {
    await extract(join(dir, file), { dir });
  }
}

run();

// Imports
const fetch = require('node-fetch');
const http = require('http');
const {JSDOM} = require('jsdom');
const C = require('colorette');
const readline = require('readline');

// Port to use webserver on
const port = process.env.PORT || 8080;

// Store all links here
const shortLinks = {};
// Short links full url
const createUrlFromId = (id) => `http://localhost:${port}/${id}`;

// Create random Id
const createRandomId = (knownIdList) => {
  const letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')[Math.floor(Math.random() * 26)];
  const number = Math.floor(Math.random() * 10000);
  const id = letter + number;

  return !knownIdList.includes(id) ? id : createRandomId(knownIdList);
}

// Because nginx doesnt allow stupid headers
const headers = {
  'Accept': 'text/html',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
  'User-Agent': 'Mozilla/5.0 (Windows NT 6.1; rv:74.0) Gecko/20100101 Firefox/74.0',
}

// Get all active kat sites
const getActiveSites = async () => {
  // Sites keep going down and comming up
  // So check another site for the currently active one
  const siteStatusUrl = 'https://kickass.lat/';
  const siteStatusReq = await fetch(siteStatusUrl, { headers });
  const siteStatusRes = await siteStatusReq.text();
  
  const siteStatusDoc = (new JSDOM(siteStatusRes)).window.document;
  const sites = Object.values(siteStatusDoc.querySelectorAll('a.domainLink')).map(x => x.textContent)
  
  // Out of these sites some of them are dead too
  const promises = await Promise.allSettled(
    sites.map((site) => 
      fetch(site, { headers }).then((res) => {
        if (res.status !== 200) throw new Error('Not Good');
        else return res.url;
      })
    )
  )

  const links = promises
      .filter(({status}) => status !== 'rejected')
      .map(({value}) => value)
  return links;
};

// Get query url
const getKATUrl = (baseUrl, query, page = 1) => `${baseUrl}usearch/${query}/${page}?field=seeders&sorder=desc`

// Scrape results from the query url
const scrapeKATResults = async (siteUrl) => {
  // Load website
  const siteReq = await fetch(siteUrl, { headers });
  const siteRes = await siteReq.text();

  const siteDoc = (new JSDOM(siteRes, {runScripts: 'outside-only', pretendToBeVisual: true})).window.document;
  const list = Object.values(siteDoc.querySelectorAll('table.data > tbody > tr'))
  
  // First row contains keys
  // We also capitalise them
  const key = Object.values(list[0].children).slice(1).map(x => {
    x = x.textContent.toLowerCase().split('');
    return x[0].toUpperCase() + x.slice(1).join('');
  })

  const results = [];
  
  // Iterate through each and scrape the details
  await Promise.all(list.slice(1)
    .map(async (x) => {
      const torrentName = (x.querySelector('.cellMainLink')).textContent.trim().replace(/\W+/g," ");
      const details = Object.fromEntries(Object.values(x.children).slice(1).map((x, i) => [key[i], x.textContent]))
      
      const rawLink = x.querySelector('a.icon16[rel="nofollow, noreferrer"]').href || ''
      const rawLinkUrl = new URL(rawLink)

      let link = ''
      // Some links are not magnet links and use service like mylink.cx
      if (rawLinkUrl.host !== 'mylink.cx') link = rawLink;
      else {
        const stupidLink = rawLinkUrl.searchParams.get('url');
        // Removes the trackers
        link = decodeURIComponent(stupidLink).split('&tr=')[0];
      }

      // Use shortened link instead of real link
      const id = createRandomId(Object.keys(shortLinks));
      shortLinks[id] = link;
      return results.push({Name: torrentName, ...details, Link: createUrlFromId(id)});
    }));
  
  return results;
}

// Combines all the data and removes the duplicates
const combineAndRemoveDuplicates = (results) => {
  return Object.values(Object.fromEntries(results.map((result) => [result.Link, result])));
}

// Starts web server for shortening links
const startWebServer = () => new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const id = req.url.split('/')[1];
    const longLink = shortLinks[id];

    // If link is found
    if (typeof longLink === 'string' && longLink.length > 0) res.write(`<a href="${longLink}"><h1>Click here</h1></a>`);
    else res.write(`<h1>404</h1><br><h2>Not Found</h2>`);
  
    res.end();
  });

  // Start listening
  server.listen(port);
  server.on('listening', () => resolve(port));
})

// Special Characters
const clearConsole = '\033c';
const clearLastLine = '\x1Bc\r';

// Write to console
const write = (str) => new Promise((res, rej) => process.stdout.write(str, (err) => err ? rej(err) : res()));
// Prompt for search
const searchPrompt = () => write(`[${C.bold(C.cyanBright('SEARCH'))}]: `);
// Print results to console
const printResults = (res) => console.table(Object.fromEntries(res.map((r) => {
  const link = r.Link;
  delete r.Link;
  return [C.redBright(link), Object.fromEntries(Object.entries(r).map(([k, v]) => [C.bold(C.blueBright(k)), v]))]
})))

// Main Function
const main = async () => {
  // Initialise
  await write(`${clearConsole}\r\n`);
  const rl = readline.createInterface(process.stdin);

  // Load
  await write(`${C.yellow('Loading...')}\r\n`); // Noitfy about loading status
  const sites = await getActiveSites();
  const port = await startWebServer();
  await write(clearLastLine);
  await write(`[${C.bold('INFO')}]: Loaded ${C.green(sites.length)} Sites\r\n`); // Notify about the sites loaded
  await write(`[${C.bold('INFO')}]: Listening on ${C.green(port)}\r\n\r\n`); // Notify about Webserver Port

  // Tiny help message
  await write(`[${C.bold('INFO')}]: Type in your query and results will be loaded\r\n`);
  await write(`[${C.bold('INFO')}]:   => Use -d flag for deep search\r\n\r\n`);

  await searchPrompt();

  // Pipe responses to commander
  rl.on('line', (line) => {
    const innerMain = async () => {
      const args = line.split(' ');
      const len = args.length;
      const isDeep = args[len - 1] == '-d' ? !!args.splice(len - 1) : false;
      const query = args.join(' ');
  
      // Deep search
      // Searches through all the websites
      if (isDeep) {
        console.log('Deep search not yet implemented');
      }
      
      // Searches through only first website
      else {
        const queryUrl = getKATUrl(sites[0], query);
        const results = await scrapeKATResults(queryUrl);
        await write('\r\n');
        printResults(results);
        await write('\r\n');
        await searchPrompt();
      }
    }

    innerMain().catch(console.error);
  });
}

main().catch((err) => console.error(err));

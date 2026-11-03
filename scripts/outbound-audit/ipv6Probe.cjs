const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const variant = process.env.IPV6_VARIANT || 'default';
app.on('window-all-closed', () => {});
// Only this minimal diagnostic disables dictionary downloads, to isolate routing.
app.on('session-created', (session) => {
  session.setSpellCheckerEnabled(false);
  session.setSpellCheckerLanguages([]);
  session.setSpellCheckerDictionaryDownloadURL('http://127.0.0.1:9/');
});
app
  .whenReady()
  .then(async () => {
    let resolver;
    if (variant !== 'default') {
      resolver = { enableBuiltInResolver: variant === 'builtin-on', secureDnsMode: 'off' };
      if (variant === 'happy-api') resolver.enableHappyEyeballs = true;
      if (variant === 'additional-off') resolver.enableAdditionalDnsQueryTypes = false;
      app.configureHostResolver(resolver);
    }
    const server = http.createServer((_request, response) => {
      response.end('<!doctype html><title>fixture</title><p>fixture</p>');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const window = new BrowserWindow({ show: false, webPreferences: { spellcheck: false, sandbox: true } });
    const results = [];
    const endpoints = [
      ['ipv4', `http://127.0.0.1:${server.address().port}/`],
      ['ipv6Literal', 'http://[2001:db8:15::2]:18080/'],
      ['ipv6Hostname', 'http://v6probe.test:18080/'],
    ];
    for (const [label, url] of process.env.IPV6_ONLY === '1' ? endpoints.slice(0, 1) : endpoints) {
      try {
        await Promise.race([
          window.loadURL(url),
          new Promise((_, reject) => setTimeout(() => reject(new Error('LOAD_TIMEOUT')), 6000)),
        ]);
        results.push({ label, ok: true });
      } catch (error) {
        results.push({ label, ok: false, error: error.message.match(/ERR_[A-Z_]+|LOAD_TIMEOUT/)?.[0] || error.name });
      }
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }
    fs.writeFileSync(
      process.env.IPV6_RESULT,
      JSON.stringify(
        {
          versions: {
            electron: process.versions.electron,
            chrome: process.versions.chrome,
            node: process.versions.node,
          },
          variant,
          resolver,
          switches: {
            enable: app.commandLine.getSwitchValue('enable-features'),
            disable: app.commandLine.getSwitchValue('disable-features'),
          },
          results,
        },
        null,
        2
      ) + '\n'
    );
    window.destroy();
    server.close(() => app.quit());
  })
  .catch((error) => {
    console.error(error);
    app.exit(1);
  });

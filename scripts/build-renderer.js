const esbuild = require('esbuild');

esbuild.buildSync({
  entryPoints: ['src/renderer/index.js'],
  bundle: true,
  outfile: 'src/renderer.bundle.js',
  platform: 'browser',
  target: 'chrome122',
});
console.log('Renderer bundle built: src/renderer.bundle.js');

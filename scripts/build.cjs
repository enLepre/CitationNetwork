const esbuild = require('esbuild');
esbuild.buildSync({ entryPoints: ['scripts/layout-entry.js'], bundle: true, format: 'iife',
  globalName: 'CitationLayout', outfile: 'assets/layout.js', minify: true, legalComments: 'eof', target: 'es2020' });

/*
 * Builds a self-contained single-file copy of the site for preview hosting.
 *
 * Every substitution goes through a replacer FUNCTION. Passing the file
 * contents as a replacement string lets JS interpret $$, $&, $` and $' as
 * insertion patterns - materials.js contains cost strings like '$$$', whose
 * trailing $' means "everything after the match" and silently duplicates the
 * whole document.
 */
const fs = require('fs');
const path = require('path');

const ROOT = '/home/user/esthers';
const OUT = process.argv[2];
if (!OUT) { console.error('usage: node tools-bundle.js <output.html>'); process.exit(1); }

const CSS = ['assets/css/base.css', 'assets/css/home.css', 'assets/css/configurator.css'];
const JS  = ['assets/js/util.js', 'assets/js/data/colours.js', 'assets/js/data/materials.js',
             'assets/js/data/work.js', 'assets/js/data/locations.js',
             'assets/js/render.js', 'assets/js/app.js'];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let html = read('index.html');

CSS.forEach((f) => {
  const tag = new RegExp('<link rel="stylesheet" href="' + esc(f) + '">');
  if (!tag.test(html)) throw new Error('stylesheet link not found: ' + f);
  const css = read(f);
  html = html.replace(tag, () => '<style>\n' + css + '\n</style>');
});

JS.forEach((f) => {
  const tag = new RegExp('<script src="' + esc(f) + '"></script>');
  if (!tag.test(html)) throw new Error('script tag not found: ' + f);
  // A literal </script> inside the code would close the block early.
  const js = read(f).replace(/<\/script/gi, '<\\/script');
  html = html.replace(tag, () => '<script>\n' + js + '\n</script>');
});

/* Images become data URIs so the page carries its own photographs. */
const imgDir = path.join(ROOT, 'assets/img');
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
               webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
/* Recursive: the gallery photographs sit in assets/img/work/, and their paths
   arrive from work.js rather than from the markup. */
const imgFiles = (dir, prefix) =>
  fs.readdirSync(dir, { withFileTypes: true }).reduce((acc, e) => (
    e.isDirectory()
      ? acc.concat(imgFiles(path.join(dir, e.name), prefix + e.name + '/'))
      : (MIME[path.extname(e.name).slice(1).toLowerCase()] ? acc.concat(prefix + e.name) : acc)
  ), []);

imgFiles(imgDir, '').forEach((img) => {
  const mime = MIME[path.extname(img).slice(1).toLowerCase()];
  const uri = 'data:' + mime + ';base64,' +
              fs.readFileSync(path.join(imgDir, img)).toString('base64');
  html = html.split('assets/img/' + img).join(uri);
});

/* The scroll reveal starts every section at opacity 0. Preview hosts render
   the page inside a frame where that can leave the whole site blank, so the
   single-file copy ships with the sections already shown. */
html = html.replace(
  /\.reveal \{\s*opacity: 0;\s*transform: translateY\(24px\);[^}]*\}/,
  () => '.reveal { opacity: 1; transform: none; }'
);

fs.writeFileSync(OUT, html, 'utf8');

/* ---- verify before anyone looks at it ---- */
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
let bad = 0;
blocks.forEach((code, i) => {
  try { new Function(code); } catch (e) { bad++; console.error('script ' + (i + 1) + ': ' + e.message); }
});
const years = (html.match(/getFullYear/g) || []).length;
console.log('script blocks: ' + blocks.length + ' (' + bad + ' with syntax errors)');
console.log('document duplication check: ' + years + ' (expected 1)');
console.log('size: ' + Math.round(fs.statSync(OUT).size / 1024) + ' KB');
if (bad || years !== 1) { console.error('BUNDLE INVALID'); process.exit(1); }
console.log('OK -> ' + OUT);

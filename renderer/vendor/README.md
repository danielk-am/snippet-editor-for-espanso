# Vendored code

`preact-htm.js` is `htm/preact/standalone.module.js` from the npm package
`htm@3.1.1` (Apache-2.0), which bundles Preact (MIT). It is copied here
unchanged so the renderer loads with no bundler and no path into
`node_modules`.

To update it, bump `htm` in `package.json`, run `npm install`, then:

```bash
cp node_modules/htm/preact/standalone.module.js renderer/vendor/preact-htm.js
```

The icon paths in `renderer/lib/icons.js` follow Lucide (ISC).

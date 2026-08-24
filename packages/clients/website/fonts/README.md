# Fonts

`inter-latin.woff2` is Inter 4.66 (SIL Open Font License 1.1, see LICENSE.txt),
subset from the upstream `InterVariable.woff2` at https://rsms.me/inter/.

The subset keeps the variable weight and optical-size axes, latin plus the
punctuation the site uses, and the layout features the design depends on:

```sh
pyftsubset InterVariable.woff2 \
  --output-file=inter-latin.woff2 --flavor=woff2 \
  --layout-features="kern,calt,liga,ccmp,locl,mark,mkmk,cv11,ss07" \
  --unicodes="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+2013,U+2014,\
U+2018-201D,U+2022,U+2026,U+00B7,U+2192,U+2212,U+FEFF"
```

`cv11` (single-storey a) and `ss07` (square punctuation) are the two that
change how the face reads; site.css turns them on in `font-feature-settings`.

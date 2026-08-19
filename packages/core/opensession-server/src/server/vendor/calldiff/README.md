# Vendored calldiff core

This directory adapts the call-tree model and structural LCS diff from
[calldiff](https://github.com/tanishqkancharla/calldiff) by Tanishq Kancharla.
The imported baseline was npm `calldiff@0.4.1` (`3217e8c`) and remains under
the upstream MIT license in `LICENSE`.

Open Session intentionally does not run the calldiff CLI or its on-demand
grammar installer. The adaptation accepts frozen source records from Open
Session's existing Git and sandbox readers, returns bounded structured data,
uses the TypeScript compiler and a pinned pure-JavaScript Rust parser, and adds
a small ReScript extractor. It also detects signature and React hook dependency
changes, follows calls inside callback bodies, resolves common Rust typed-method
and trait-implementation edges, and removes unchanged leaves from UI output.

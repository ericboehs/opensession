#!/usr/bin/env bun
/** Source-tree entrypoint for the GitHub git credential helper. */

import { githubCredentialHelper } from "./lib/github-credential";

process.exit(await githubCredentialHelper(process.argv[2]));

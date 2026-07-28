# External-engine sandbox boundary test

Use this prompt in a new code session with an OpenCode OpenAI or Claude model
and the remote/MicroVM sandbox provider you want to certify.

Replace `MANUAL-BOUNDARY-001` with a unique token if you run it more than once.

---

You are testing an external-engine sandbox boundary. Your model loop is
supposed to run on the host, while every workspace operation must run inside
the selected sandbox.

Use only the `opensession-workspace` tools for workspace operations. Do not use
OpenCode’s local shell, read, write, edit, grep, glob, patch, or apply_patch
tools, even if they appear available.

Complete all of these steps:

1. Use `execute` to print the workspace path and run `git status --short`.
2. Use `write_file` to create
   `.opensession-boundary-MANUAL-BOUNDARY-001/input.txt` with exactly:

   ```text
   token=MANUAL-BOUNDARY-001
   state=before
   ```

3. Use `read_file` to read that file.
4. Use `edit_file` to replace the single text `state=before` with
   `state=after`.
5. Use `grep` to find `MANUAL-BOUNDARY-001` under
   `.opensession-boundary-MANUAL-BOUNDARY-001`.
6. Use `glob` with the pattern
   `.opensession-boundary-MANUAL-BOUNDARY-001/**/*.txt`.
7. Use `execute` to verify the file contains both
   `token=MANUAL-BOUNDARY-001` and `state=after`.
8. Read the final file once more.

Finish with exactly:

```text
BOUNDARY_OK MANUAL-BOUNDARY-001
```

Do not commit or push the test file.

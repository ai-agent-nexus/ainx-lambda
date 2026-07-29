#!/usr/bin/env python3
"""
Build dynamic function matrix from changed files detected by dorny/paths-filter.

Usage:
    python scripts/build-function-matrix.py <changed_files_json>

Input: JSON array of changed file paths (from paths-filter's *_files output)
Output: JSON array of unique function names, written to GITHUB_OUTPUT if available

Example:
    echo '["functions/auth-token/src/index.ts", "functions/auth-token/__tests__/unit.test.ts"]' | \
        python scripts/build-function-matrix.py
    # Output: ["auth-token"]
"""

import json
import os
import sys


def extract_functions(changed_files: list[str]) -> list[str]:
    """Extract unique function names from changed file paths."""
    functions = set()
    for path in changed_files:
        parts = path.split('/')
        if len(parts) >= 2 and parts[0] == 'functions':
            functions.add(parts[1])
    return sorted(list(functions))


def main():
    # Read input from argument or stdin
    if len(sys.argv) > 1:
        input_data = sys.argv[1]
    else:
        input_data = sys.stdin.read().strip()

    # Handle empty input
    if not input_data or input_data == '[]':
        matrix = []
    else:
        try:
            files = json.loads(input_data)
            matrix = extract_functions(files)
        except json.JSONDecodeError as e:
            print(f"Error: Invalid JSON input: {e}", file=sys.stderr)
            sys.exit(1)

    # Output as JSON
    output = json.dumps(matrix)
    print(output)

    # If running in GitHub Actions, write to GITHUB_OUTPUT
    github_output = os.environ.get('GITHUB_OUTPUT')
    if github_output:
        with open(github_output, 'a') as f:
            f.write(f"function-matrix={output}\n")
        print(f"Changed functions: {output}", file=sys.stderr)


if __name__ == '__main__':
    main()

/**
 * Pattern helpers for user-supplied rules.
 *
 * Path/URL patterns:
 *   - "re:<expr>"  regular expression (JavaScript syntax, case-sensitive)
 *   - contains "*" glob: "*" matches any characters except "/", "**" matches anything
 *   - otherwise    prefix rule on segment boundaries: "/admin" matches "/admin",
 *                  "/admin/" and "/admin/users" but not "/administrator"
 *
 * Host patterns:
 *   - "example.com"    exact hostname
 *   - "*.example.com"  any subdomain of example.com (not example.com itself)
 */

function escapeRegex(s) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else {
        re += '[^/]*';
      }
    } else {
      re += escapeRegex(c);
    }
  }
  return new RegExp(`^${re}$`);
}

/** Compile a path/URL pattern into a predicate. Throws on invalid regular expressions. */
export function compilePattern(pattern, { prefixMode = true } = {}) {
  if (pattern.startsWith('re:')) {
    const re = new RegExp(pattern.slice(3));
    return (value) => re.test(value);
  }
  if (pattern.includes('*')) {
    const re = globToRegExp(pattern);
    return (value) => re.test(value);
  }
  if (!prefixMode) return (value) => value === pattern;
  const base = pattern.endsWith('/') && pattern.length > 1 ? pattern.slice(0, -1) : pattern;
  return (value) => value === base || value.startsWith(base.endsWith('/') ? base : `${base}/`);
}

export function compilePatternList(patterns, opts) {
  const fns = patterns.map((p) => compilePattern(p, opts));
  return (value) => fns.some((fn) => fn(value));
}

export function hostMatchesPattern(hostname, pattern) {
  const p = pattern.toLowerCase();
  if (p.startsWith('*.')) {
    const root = p.slice(2);
    return hostname.length > root.length + 1 && hostname.endsWith(`.${root}`);
  }
  return hostname === p;
}

export function hostMatchesAny(hostname, patterns) {
  return patterns.some((p) => hostMatchesPattern(hostname, p));
}

/** Levenshtein distance, used for "did you mean" suggestions. */
export function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

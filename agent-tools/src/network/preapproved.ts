/**
 * Pre-approved web domain list (ported from Claude Code 2.1.88 WebFetchTool/preapproved.ts)
 *
 * These sites are development documentation sources with stable, quality content in a controlled manner.
 * When WebFetch hits this list:
 *   - Skip the domain-blacklist preflight (that layer is Claude Code's SSRF guard;
 *     philont already has an SSRF/network-guard layer; preapproved is primarily an optimization)
 *   - When content length is manageable, skip LLM distillation and return raw markdown directly
 *
 * SECURITY NOTE: This list is for WebFetch (GET-only) only. Never extend it to tools that allow
 * POST/upload — huggingface/kaggle/nuget all allow file uploads, which would create a data-exfiltration risk.
 */

export const PREAPPROVED_HOSTS: ReadonlySet<string> = new Set([
  // Anthropic
  'platform.claude.com',
  'code.claude.com',
  'modelcontextprotocol.io',
  'github.com/anthropics',
  'agentskills.io',

  // Top-tier programming languages
  'docs.python.org',
  'en.cppreference.com',
  'docs.oracle.com',
  'learn.microsoft.com',
  'developer.mozilla.org',
  'go.dev',
  'pkg.go.dev',
  'www.php.net',
  'docs.swift.org',
  'kotlinlang.org',
  'ruby-doc.org',
  'doc.rust-lang.org',
  'www.typescriptlang.org',

  // Web/JS frameworks
  'react.dev',
  'angular.io',
  'vuejs.org',
  'nextjs.org',
  'expressjs.com',
  'nodejs.org',
  'bun.sh',
  'jquery.com',
  'getbootstrap.com',
  'tailwindcss.com',
  'd3js.org',
  'threejs.org',
  'redux.js.org',
  'webpack.js.org',
  'jestjs.io',
  'reactrouter.com',

  // Python frameworks/libraries
  'docs.djangoproject.com',
  'flask.palletsprojects.com',
  'fastapi.tiangolo.com',
  'pandas.pydata.org',
  'numpy.org',
  'www.tensorflow.org',
  'pytorch.org',
  'scikit-learn.org',
  'matplotlib.org',
  'requests.readthedocs.io',
  'jupyter.org',

  // PHP frameworks
  'laravel.com',
  'symfony.com',
  'wordpress.org',

  // Java frameworks/libraries
  'docs.spring.io',
  'hibernate.org',
  'tomcat.apache.org',
  'gradle.org',
  'maven.apache.org',

  // .NET / C# (unchanged)
  'asp.net',
  'dotnet.microsoft.com',
  'nuget.org',
  'blazor.net',

  // Mobile (unchanged)
  'reactnative.dev',
  'docs.flutter.dev',
  'developer.apple.com',
  'developer.android.com',

  // Data science/ML
  'keras.io',
  'spark.apache.org',
  'huggingface.co',
  'www.kaggle.com',

  // Databases
  'www.mongodb.com',
  'redis.io',
  'www.postgresql.org',
  'dev.mysql.com',
  'www.sqlite.org',
  'graphql.org',
  'prisma.io',

  // Cloud / DevOps
  'docs.aws.amazon.com',
  'cloud.google.com',
  'kubernetes.io',
  'www.docker.com',
  'www.terraform.io',
  'www.ansible.com',
  'vercel.com/docs',
  'docs.netlify.com',
  'devcenter.heroku.com',

  // Testing / monitoring
  'cypress.io',
  'selenium.dev',

  // Game development
  'docs.unity.com',
  'docs.unrealengine.com',

  // Other essentials
  'git-scm.com',
  'nginx.org',
  'httpd.apache.org',

  // Academic / papers
  'arxiv.org',
]);

// Put host-only entries in a Set; group path-containing entries (e.g. github.com/anthropics) by host
// into a path-prefix Map; lookup does O(1) host match first, then small-list prefix match.
const { HOSTNAME_ONLY, PATH_PREFIXES } = (() => {
  const hosts = new Set<string>();
  const paths = new Map<string, string[]>();
  for (const entry of PREAPPROVED_HOSTS) {
    const slash = entry.indexOf('/');
    if (slash === -1) {
      hosts.add(entry);
    } else {
      const host = entry.slice(0, slash);
      const path = entry.slice(slash);
      const prefixes = paths.get(host) ?? [];
      prefixes.push(path);
      paths.set(host, prefixes);
    }
  }
  return { HOSTNAME_ONLY: hosts, PATH_PREFIXES: paths };
})();

/**
 * Check whether a host[+path] is in the pre-approved list.
 *
 * Path prefix matching enforces segment boundaries — `/anthropics` will not
 * accidentally match `/anthropics-evil/...`.
 */
export function isPreapprovedHost(hostname: string, pathname: string): boolean {
  if (HOSTNAME_ONLY.has(hostname)) return true;
  const prefixes = PATH_PREFIXES.get(hostname);
  if (!prefixes) return false;
  for (const p of prefixes) {
    if (pathname === p || pathname.startsWith(p + '/')) return true;
  }
  return false;
}

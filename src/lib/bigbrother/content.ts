/**
 * BIGBROTHER's knowledge of DARKNOTE.
 *
 * This is a registry of the application's real pages plus the procedures that
 * follow from them. Every href here is checked against the App Router in the
 * test suite, so the assistant cannot advertise a page that does not exist.
 */

export interface NavPage {
  id: string;
  href: string;
  title: string;
  summary: string;
  keywords: string[];
  /** What the page actually shows, in the app's own terms. */
  details: string[];
  commonTasks: string[];
}

export const NAV_PAGES: NavPage[] = [
  {
    id: 'overview',
    href: '/',
    title: 'Overview',
    summary: 'The landing dashboard: server state, WhatsApp verdict, quick actions and recent activity.',
    keywords: ['overview', 'home', 'dashboard', 'start', 'main page', 'landing'],
    details: [
      'Shows the active server selected in the header picker.',
      'Separates container state from WhatsApp state — they are different facts.',
      'Links to every other section from the left sidebar.',
    ],
    commonTasks: ['See whether the bot is running', 'Jump to a section', 'Check recent deployments'],
  },
  {
    id: 'monitor',
    href: '/monitor',
    title: 'Live Monitor',
    summary: 'Live container state, CPU/RAM/disk, uptime, WhatsApp verdict, console tail and Start/Stop/Restart.',
    keywords: ['monitor', 'live', 'status', 'cpu', 'ram', 'restart', 'start', 'stop', 'power', 'uptime', 'online', 'offline'],
    details: [
      'Reads /resources from the panel on every refresh; missing values show "—", never 0.',
      'WhatsApp state comes from the bot process status file or from console connection events.',
      'Start / Stop / Restart send POST /api/client/servers/{id}/power with {signal}.',
    ],
    commonTasks: ['Restart the bot', 'Check memory usage', 'See why WhatsApp shows unknown'],
  },
  {
    id: 'discovery',
    href: '/discovery',
    title: 'Server Discovery',
    summary: 'Walks the real server filesystem and builds the file index, hashes and command metadata.',
    keywords: ['discovery', 'scan', 'index', 'filesystem', 'walk', 'commands', 'ast'],
    details: [
      'Recursive scan with depth and file-count limits (DARKNOTE_MAX_INDEX_DEPTH / _FILES).',
      'Skipped by policy: WhatsApp session folders, .env, creds.json, private keys.',
      'Produces the index used by Global Search, Project Explorer and BIGBROTHER file search.',
    ],
    commonTasks: ['Index a fresh project', 'Find commands', 'Refresh stale file data'],
  },
  {
    id: 'files',
    href: '/files',
    title: 'File Manager',
    summary: 'Browse and change production files directly: create, rename, move, copy, delete, upload and import a ZIP.',
    keywords: ['files', 'file manager', 'upload', 'zip import', 'rename', 'delete file', 'new folder', 'path'],
    details: [
      'Shows one directory at a time, with the current path kept in the URL (?path=/lib).',
      'Protected paths (sessions, .env, credentials) are refused for read and write by policy.',
      'ZIP import rejects traversal entries and inspects the archive before writing.',
    ],
    commonTasks: ['Upload a plugin file', 'Rename or move a file', 'Create a folder'],
  },
  {
    id: 'explorer',
    href: '/explorer',
    title: 'Project Explorer',
    summary: 'The intelligent view of the project: verified entry point, plugins, cases, functions, configuration and dependency health.',
    keywords: ['project explorer', 'explorer', 'plugins', 'plugin', 'structure', 'entry point', 'main file', 'dependencies', 'package.json', 'categories'],
    details: [
      'Categories: Plugins, package.json & dependencies, Main file / entry point, Cases / commands, Functions / helpers, Configuration / settings, Database / models / storage.',
      'The entry point is verified against the filesystem, not inferred from a name.',
      'Dependency freshness and search coverage are opt-in checks, so a page load never triggers a long scan.',
    ],
    commonTasks: ['Find all plugins', 'See the real main file', 'Inspect cases and functions'],
  },
  {
    id: 'editor',
    href: '/editor',
    title: 'Code Editor',
    summary: 'Monaco editor with multi-tab editing, chunked large-file IO, validation, diff and deploy.',
    keywords: ['editor', 'code', 'edit', 'monaco', 'draft', 'save', 'validate', 'deploy file', 'line'],
    details: [
      'Opens a file with ?path=/main.js and jumps to a line with &line=42.',
      'Saves a server-side draft; deployment writes and verifies the production file.',
      'Validation runs before deploy (acorn + node --check for JavaScript).',
    ],
    commonTasks: ['Open main.js', 'Fix a syntax error', 'Deploy an edited file'],
  },
  {
    id: 'cases',
    href: '/cases',
    title: 'Case Manager',
    summary: 'Every switch case in the bot, parsed from the AST, with structural checks on edit.',
    keywords: ['cases', 'case manager', 'command', 'commands', 'switch', 'alias', 'menu'],
    details: [
      'Lists command cases and aliases with their file and line range.',
      'Edits are checked for duplicate case labels and broken syntax.',
    ],
    commonTasks: ['Find a command', 'Rename a command', 'Remove a duplicate case'],
  },
  {
    id: 'search',
    href: '/search',
    title: 'Global Search',
    summary: 'Text, regex (ReDoS-guarded) and AST search across the indexed production files.',
    keywords: ['search', 'find', 'grep', 'regex', 'global search', 'look for', 'locate'],
    details: [
      'Searches the indexed snapshot; opening a result re-verifies it against the panel.',
      'AST mode matches command names and function names rather than raw text.',
    ],
    commonTasks: ['Find a function', 'Find every use of a string', 'Locate a command handler'],
  },
  {
    id: 'sync',
    href: '/sync',
    title: 'Synchronization',
    summary: 'Index reconciliation, hash-based conflict detection and resolution.',
    keywords: ['sync', 'synchronization', 'conflict', 'drift', 'reconcile', 'poll'],
    details: [
      'Compares indexed hashes with production and records remote changes.',
      'Conflicts keep both sides until you choose one; nothing is overwritten silently.',
    ],
    commonTasks: ['Resolve a conflict', 'See what changed outside DARKNOTE', 'Re-scan'],
  },
  {
    id: 'deployments',
    href: '/deployments',
    title: 'Deployments',
    summary: 'Backup → validate → atomic write → hash verify → restart → startup observation → rollback.',
    keywords: ['deploy', 'deployment', 'rollback', 'release', 'publish', 'failed deploy'],
    details: [
      'Every deployment records its steps, hashes and captured startup output.',
      'A failed health check restores only the files that deployment changed.',
    ],
    commonTasks: ['See why a deploy failed', 'Roll back a deployment', 'Read startup logs'],
  },
  {
    id: 'backups',
    href: '/backups',
    title: 'Backups & Versions',
    summary: 'Private content-addressed backup store plus panel-created backups and file versions.',
    keywords: ['backup', 'backups', 'version', 'versions', 'restore', 'history', 'snapshot'],
    details: [
      'Backups live outside public/ and are read back only through authenticated routes.',
      'Every write stores the previous content as a version before changing production.',
    ],
    commonTasks: ['Restore an earlier version', 'Download a backup', 'Create a panel backup'],
  },
  {
    id: 'downloads',
    href: '/downloads',
    title: 'Download Center',
    summary: 'Download files, folders or the whole project with a verified SHA-256, secrets excluded.',
    keywords: ['download', 'downloads', 'export', 'zip', 'project download', 'entire project', 'get my files'],
    details: [
      'Serves freshly-read production bytes and reports the SHA-256.',
      'Session folders, .env and credential files are excluded by policy, not by accident.',
    ],
    commonTasks: ['Download the whole bot project', 'Download one folder', 'Export a file'],
  },
  {
    id: 'console',
    href: '/console',
    title: 'Terminal & Logs',
    summary: 'The real panel console over one persistent authenticated websocket, relayed to the browser.',
    keywords: ['console', 'terminal', 'logs', 'output', 'command', 'npm install', 'shell', 'stdout'],
    details: [
      'Commands are sent only after confirmation and are recorded in the audit trail.',
      'The same buffer feeds Live Monitor and deployment health checks.',
    ],
    commonTasks: ['Run npm install', 'Read the startup error', 'Watch a restart'],
  },
  {
    id: 'errors',
    href: '/errors',
    title: 'Error Center',
    summary: 'Captured failures with root cause, affected file and line, severity, fix and repair workflow.',
    keywords: ['error', 'errors', 'error center', 'diagnostics', 'failure', 'root cause', 'fix', 'severity'],
    details: [
      'Groups repeats by fingerprint and counts occurrences.',
      'Filters by severity, source, status and free text; keeps history of resolved problems.',
      'Links the affected file straight into the Code Editor or Project Explorer.',
    ],
    commonTasks: ['See active critical errors', 'Open the affected file', 'Prepare a repair'],
  },
  {
    id: 'settings',
    href: '/settings',
    title: 'Admin Settings',
    summary: 'Pterodactyl connection, capabilities probe, server policy, accounts, roles and security posture.',
    keywords: ['settings', 'admin', 'api key', 'pterodactyl', 'connection', 'accounts', 'roles', 'policy', 'secret', 'editor limit'],
    details: [
      'Panel URL, server identifier and Client API key are stored encrypted and never returned to the browser.',
      'Test connection performs real reads and reports the exact failure when one occurs.',
      'Server policy controls editor limit, excluded paths, startup timeout and auto-restart.',
    ],
    commonTasks: ['Connect Pterodactyl', 'Create a Client API key', 'Change the editor limit', 'Add an account'],
  },
  {
    id: 'bigbrother',
    href: '/bigbrother',
    title: 'BIGBROTHER AI',
    summary: 'This assistant: DARKNOTE navigation, project file search, error explanations and guided tutorials.',
    keywords: ['bigbrother', 'ai', 'assistant', 'chat', 'conversation', 'memory', 'tutorial'],
    details: [
      'Answers are grounded in the live index, the error store and the navigation registry.',
      'Conversations are stored per account and can be resumed or deleted.',
      'Production actions always require confirmation.',
    ],
    commonTasks: ['Ask where a feature is', 'Find a file', 'Explain an error'],
  },
];

export interface TutorialStep {
  title: string;
  body: string;
  /** Matches an uploaded asset caption/slug when the owner supplies screenshots. */
  assetHint?: string;
  /** Uploaded image shown with this step (custom tutorials only). */
  assetId?: string;
  link?: string;
  linkLabel?: string;
}

export interface Tutorial {
  slug: string;
  title: string;
  summary: string;
  keywords: string[];
  steps: TutorialStep[];
}

export const BUILTIN_TUTORIALS: Tutorial[] = [
  {
    slug: 'pterodactyl-client-api-key',
    title: 'Get a Pterodactyl Client API Key and connect DARKNOTE',
    summary:
      'The control center needs a Client API key (ptlc_), created in the panel under Account → API Credentials, then pasted into Admin Settings.',
    keywords: ['api key', 'client api key', 'pterodactyl key', 'ptlc', 'connect panel', 'credentials', 'account'],
    steps: [
      {
        title: 'Open your Pterodactyl panel',
        body: 'Sign in to the panel that hosts the Darknote server. Use the same account that owns (or is a subuser of) that server — a key from another account cannot see it.',
        link: '/settings',
        linkLabel: 'DARKNOTE connection settings',
        assetHint: 'panel-login',
      },
      {
        title: 'Open Account',
        body: 'Click your avatar or name in the top-right corner and choose Account. Do not use the Admin area: the Admin area issues Application keys (ptla_), which the Client API rejects.',
        assetHint: 'panel-account',
      },
      {
        title: 'Open API Credentials',
        body: 'In the Account page select API Credentials. Existing keys are listed there; a new key is created from the same screen.',
        assetHint: 'panel-api-credentials',
      },
      {
        title: 'Create the key',
        body: 'Choose Create API Key. Give it a description such as “DARKNOTE Control Center”. Leave Allowed IPs empty unless you want to restrict the key to this server’s egress IP. Save, then copy the key immediately — the panel shows it only once.',
        assetHint: 'panel-create-key',
      },
      {
        title: 'Confirm it is a Client key',
        body: 'The key must start with ptlc_. If it starts with ptla_ it is an Application key and every file or power call will fail with 401.',
        assetHint: 'panel-key-copied',
      },
      {
        title: 'Paste it into DARKNOTE',
        body: 'Open Admin Settings → Pterodactyl connection. Enter the panel URL (https://panel.example.com, no /api/client suffix), the short server identifier from the panel URL (/server/<identifier>), and the key. Save.',
        link: '/settings',
        linkLabel: 'Open Admin Settings',
        assetHint: 'darknote-settings',
      },
      {
        title: 'Verify the connection',
        body: 'Press Test connection. A working setup reports the panel version, your account, the server name and state, and the subuser permissions. Then open Live Monitor: resources and container state should appear within one refresh.',
        link: '/monitor',
        linkLabel: 'Open Live Monitor',
        assetHint: 'darknote-test-connection',
      },
    ],
  },
  {
    slug: 'restart-bot',
    title: 'Restart the WhatsApp bot safely',
    summary: 'Restart from Live Monitor or the Overview page; the panel receives a power signal and the console is watched for real startup output.',
    keywords: ['restart', 'reboot', 'start bot', 'stop bot', 'power', 'restart bot'],
    steps: [
      {
        title: 'Open Live Monitor',
        body: 'Select the correct server in the header picker first. The monitor shows the container state and the live console tail.',
        link: '/monitor',
        linkLabel: 'Open Live Monitor',
      },
      {
        title: 'Press Restart and confirm',
        body: 'The confirmation explains that the panel will receive POST /api/client/servers/{identifier}/power with {"signal":"restart"}. This acts on the running process, not on files.',
      },
      {
        title: 'Watch the console',
        body: 'Startup lines appear in the console panel. A healthy start shows the bot loading commands and then a WhatsApp connection-open event. If you see SyntaxError or Cannot find module, open the Error Center — the file and line are recorded there.',
        link: '/errors',
        linkLabel: 'Open Error Center',
      },
    ],
  },
  {
    slug: 'download-project',
    title: 'Download the entire bot project',
    summary: 'Download Center packages production files with a verified SHA-256; WhatsApp sessions and credentials are excluded.',
    keywords: ['download project', 'download everything', 'export project', 'zip project', 'backup project'],
    steps: [
      {
        title: 'Open Download Center',
        body: 'Choose the project scope rather than a single file. The archive is built from freshly-read production bytes.',
        link: '/downloads',
        linkLabel: 'Open Download Center',
      },
      {
        title: 'Review what is excluded',
        body: 'Session folders, .env files, creds.json, pre-keys and private keys are excluded by policy. The UI lists the exclusions before the download starts — it never silently drops files.',
      },
      {
        title: 'Verify the checksum',
        body: 'The response includes the SHA-256 of the archive. The download history keeps the same hash so you can prove later that the file you hold is the one that was served.',
        link: '/downloads',
        linkLabel: 'Download history',
      },
    ],
  },
  {
    slug: 'find-main-file',
    title: 'Find the main bot file and open it',
    summary: 'Search the indexed project for the entry file, then open it at the right line in the Code Editor.',
    keywords: ['main.js', 'main file', 'entry point', 'index.js', 'bot file', 'where is main'],
    steps: [
      {
        title: 'Let BIGBROTHER search the index',
        body: 'Ask “where is my main.js file”. The answer lists real paths from the file index with the matching line, not a guess.',
      },
      {
        title: 'Confirm it in Project Explorer',
        body: 'The “Main file / entry point” category shows the file the panel actually starts, verified against the filesystem.',
        link: '/explorer',
        linkLabel: 'Open Main file / entry point',
      },
      {
        title: 'Open it in the Code Editor',
        body: 'Select the result. The editor opens /editor?path=/…&line=… so the cursor lands on the matched line.',
        link: '/editor',
        linkLabel: 'Open Code Editor',
      },
      {
        title: 'If nothing is indexed',
        body: 'Run Server Discovery first. An empty index means the project has not been scanned yet, and no search can be accurate until it has.',
        link: '/discovery',
        linkLabel: 'Run Server Discovery',
      },
    ],
  },
  {
    slug: 'whatsapp-reconnect',
    title: 'Reconnect WhatsApp when the session drops',
    summary: 'Distinguish a logout from a network drop, then pair the device again without destroying the old session prematurely.',
    keywords: ['whatsapp offline', 'whatsapp disconnected', 'reconnect whatsapp', 'qr', 'pairing', 'logged out'],
    steps: [
      {
        title: 'Read the current verdict',
        body: 'Live Monitor shows WhatsApp state with its source. “Not observed yet” means no connection event has been printed — it does not mean connected.',
        link: '/monitor',
        linkLabel: 'Open Live Monitor',
      },
      {
        title: 'Check the console for the exact line',
        body: 'A 401 or “logged out” means the device was unlinked. “Stream errored” or “connection closed” is a transport drop. The Error Center records both with different root causes.',
        link: '/console',
        linkLabel: 'Open Terminal & Logs',
      },
      {
        title: 'Pair again if needed',
        body: 'Restart the bot and read the QR or pairing code from the console, then link it from WhatsApp → Linked devices → Link a device. Wait for a connection-open line before assuming success.',
        link: '/errors',
        linkLabel: 'Open Error Center',
      },
    ],
  },
  {
    slug: 'deployment-failure',
    title: 'Diagnose a failed deployment',
    summary: 'Read the deployment record: validation, write, restart and startup health are separate steps with separate evidence.',
    keywords: ['deployment failing', 'deploy failed', 'rollback', 'health check failed', 'startup failed'],
    steps: [
      {
        title: 'Open the failed deployment',
        body: 'Deployments lists every run with its status. Open the record to see each step and the captured console output.',
        link: '/deployments',
        linkLabel: 'Open Deployments',
      },
      {
        title: 'Identify the failing step',
        body: 'Validation failure means nothing was written. Write failure means production was untouched or restored. A health failure means files were written, then rolled back after the bot failed to start.',
      },
      {
        title: 'Fix and redeploy',
        body: 'Open the affected file from the Error Center, correct the cause, validate, then deploy again. Backups & Versions keeps the previous content restorable.',
        link: '/errors',
        linkLabel: 'Open Error Center',
      },
    ],
  },
  {
    slug: 'editor-save-deploy',
    title: 'Edit and deploy a production file',
    summary: 'Draft → validate → diff → deploy, with a backup and hash verification on the real file.',
    keywords: ['edit file', 'save file', 'deploy file', 'editor', 'draft', 'validate'],
    steps: [
      {
        title: 'Open the file',
        body: 'Use Project Explorer or ask BIGBROTHER to find it. The editor loads production content and records its hash.',
        link: '/explorer',
        linkLabel: 'Open Project Explorer',
      },
      {
        title: 'Edit and validate',
        body: 'Validation is debounced for large files and skipped above 400 K characters so typing stays responsive. JavaScript is parsed with acorn and checked with node --check.',
      },
      {
        title: 'Review the diff and deploy',
        body: 'Deploy shows the diff first. On confirm, DARKNOTE backs up the current content, writes atomically, verifies the SHA-256, restarts and observes startup. A failed start rolls the file back.',
        link: '/deployments',
        linkLabel: 'Deployment history',
      },
    ],
  },
  {
    slug: 'live-monitor-unknown',
    title: 'Why Live Monitor shows Unknown',
    summary: 'A running container is not a connected WhatsApp session. “Unknown” is an honest verdict when no connection event was observed.',
    keywords: ['unknown', 'live monitor unknown', 'whatsapp unknown', 'status unknown', 'not observed'],
    steps: [
      {
        title: 'Check the two states separately',
        body: 'Container state comes from /resources. WhatsApp state comes only from the bot process status file or from WhatsApp-specific console events for the current process.',
        link: '/monitor',
        linkLabel: 'Open Live Monitor',
      },
      {
        title: 'Confirm the console is attached',
        body: 'If the console websocket is not attached, no event can be observed, so the badge must stay unknown. The monitor states this instead of guessing.',
        link: '/console',
        linkLabel: 'Open Terminal & Logs',
      },
      {
        title: 'Make the state authoritative (optional)',
        body: 'Have the bot write {"whatsapp":"connected","startedAt":"…"} to a file and set DARKNOTE_BOT_STATUS_PATH to that path. The badge then follows the bot’s own report.',
        link: '/settings',
        linkLabel: 'Open Admin Settings',
      },
    ],
  },
  {
    slug: 'plugins-folder',
    title: 'Find and manage plugins',
    summary: 'Plugins are project folders, not a separate page: open Project Explorer at the plugins directory.',
    keywords: ['plugins', 'plugin folder', 'commands folder', 'modules', 'extensions'],
    steps: [
      {
        title: 'Open Project Explorer',
        body: 'Project Explorer groups the real project into categories, so plugins are visible without guessing a path.',
        link: '/explorer',
        linkLabel: 'Open Project Explorer',
      },
      {
        title: 'Open the Plugins category',
        body: 'Choose Plugins to list every plugin module with its files, commands and dependencies. If no plugin directory was found, the category says so rather than showing an empty claim. You can also open the raw folder in File Manager.',
        link: '/explorer',
        linkLabel: 'Open the Plugins category',
      },
      {
        title: 'Inspect or edit a plugin',
        body: 'Select a file to open it in the Code Editor. Deploying a change backs up the current file and verifies the write.',
        link: '/editor',
        linkLabel: 'Open Code Editor',
      },
    ],
  },
];

export interface SettingsTopic {
  id: string;
  label: string;
  keywords: string[];
  explanation: string;
  link: string;
}

export const SETTINGS_TOPICS: SettingsTopic[] = [
  {
    id: 'api-key',
    label: 'Client API key',
    keywords: ['api key', 'ptlc', 'credential', 'pterodactyl key'],
    explanation:
      'Created in the panel under Account → API Credentials. It starts with ptlc_ and is stored encrypted with DARKNOTE_SECRET. An Application key (ptla_) is rejected up front because it cannot call /api/client.',
    link: '/settings',
  },
  {
    id: 'editor-limit',
    label: 'Editor file limit',
    keywords: ['editor limit', 'file too large', '413', 'max file', 'megabyte'],
    explanation:
      'Per-server ceiling for opening or editing one text file (default 16 MB). It is clamped by the process ceiling DARKNOTE_MAX_EDITOR_BYTES (default 64 MB). Files above the limit are refused with their real size — never truncated.',
    link: '/settings',
  },
  {
    id: 'startup-timeout',
    label: 'Startup timeout',
    keywords: ['startup timeout', 'health check', 'restart timeout'],
    explanation:
      'How long a deployment waits for the container to reach running after a restart (default 90 s). Health is only called healthy when startup output was actually observed.',
    link: '/settings',
  },
  {
    id: 'excluded-paths',
    label: 'Excluded paths',
    keywords: ['excluded paths', 'ignore', 'skip folder', 'session folder'],
    explanation:
      'Paths never indexed, read or written: WhatsApp sessions, .env files, credentials and private keys are always blocked regardless of this list.',
    link: '/settings',
  },
  {
    id: 'auto-restart',
    label: 'Auto restart',
    keywords: ['auto restart', 'restart policy'],
    explanation:
      'When enabled, deploying a file that affects the process (js/ts/json/sh) triggers a restart and a startup observation. Disable it to write files without restarting.',
    link: '/settings',
  },
  {
    id: 'scan-interval',
    label: 'Synchronization interval',
    keywords: ['sync interval', 'scan interval', 'polling'],
    explanation:
      'Pterodactyl has no file-change webhook, so changes made in the panel are found by polling. Shorter intervals detect drift sooner and use more panel API calls.',
    link: '/settings',
  },
  {
    id: 'session-hours',
    label: 'Session lifetime',
    keywords: ['session hours', 'logout', 'login expires'],
    explanation:
      'How long a DARKNOTE sign-in stays valid (DARKNOTE_SESSION_HOURS, default 12). Signing out revokes the session immediately.',
    link: '/settings',
  },
];

export const ABOUT_BIGBROTHER = {
  name: 'BIGBROTHER',
  identity:
    'I am BIGBROTHER, the intelligent assistant of DARKNOTE. I was created by BIGBROTHER, the owner of the DARKNOTE project.',
  scope: [
    'Explaining every page and control in the DARKNOTE Control Center',
    'Finding real files, commands and functions in the indexed bot project',
    'Explaining captured errors with their actual cause and location',
    'Preparing navigation and, with your authorisation, production changes',
    'Remembering your previous conversations and the context you gave me',
  ],
};

#!/usr/bin/env node

import BetterSqlite3 from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

type AppDb = {
  close: () => void;
  exec: (sql: string) => unknown;
  query: (sql: string) => any;
};

type SnippetRow = {
  id: number;
  title: string;
  content: string;
  created_at: string;
  updated_at: string;
};

type SnippetSummary = {
  id: number;
  title: string;
  tags: string;
  updated_at: string;
};

type ProfileRow = {
  id: number;
  name: string;
  description: string | null;
  tags: string;
  match_mode: SelectionMode;
  target: ExportTarget | "all";
  created_at: string;
  updated_at: string;
};

type TemplateRow = {
  id: number;
  name: string;
  description: string | null;
  body: string;
  target: ExportTarget | "all";
  created_at: string;
  updated_at: string;
};

type ExportTarget = "markdown" | "codex" | "claude";
type SelectionMode = "any" | "all";

const GLOBAL_DATA_DIR = resolve(homedir(), ".instructable");
const DEFAULT_DB_PATH = resolve(GLOBAL_DATA_DIR, "instructable.db");
const LEGACY_LOCAL_DB_PATH = resolve(process.cwd(), "instructable.db");
const DB_PATH = resolve(process.env.INSTRUCTABLE_DB_PATH ?? DEFAULT_DB_PATH);
const AGENT_TAG_KEYS = ["agent:", "runtime:"];
const SHARED_AGENT_TAGS = ["agent:shared", "runtime:shared", "shared:true"];
const SQLITE_SERIAL_WARNING =
  "SQLite writes should be treated as serial. Concurrent write commands against the same DB can lock.";

function usage() {
  console.log(`Instructable

Usage:
  instructable init
  instructable add --title "Name" --content "Text" --tags role:dev,style:concise
  instructable list
  instructable show --id 1
  instructable update --id 1 [--title "..."] [--content "..."] [--tags a,b]
  instructable delete --id 1
  instructable compose [--target codex|claude|markdown] [--tags a,b] [--ids 1,2]
  instructable export --target codex [--tags a,b] [--ids 1,2] [--out AGENTS.md]
  instructable export --target claude [--tags a,b] [--ids 1,2] [--out CLAUDE.md]
  instructable install --target all [--tags a,b] [--ids 1,2]
  instructable profile save --name reviewer --tags policy:core,role:reviewer --match all --target codex
  instructable profile list
  instructable profile show --name reviewer
  instructable template save --name codex-default --target codex --body "# AGENTS.md\n\n{{managed_notice}}\n\n## Core\n{{query tags=\"policy:core\" match=\"all\"}}"
  instructable template list
  instructable template show --name codex-default

Note:
  ${SQLITE_SERIAL_WARNING}

Database:
  ${DB_PATH}
`);
}

function parseArgs(argv: string[]) {
  const [command, ...rest] = argv;
  const flags: Record<string, string> = {};

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith("--")) {
      continue;
    }
    const key = token.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      flags[key] = "true";
      continue;
    }
    flags[key] = next;
    i += 1;
  }

  return { command, flags };
}

function splitCsv(value?: string) {
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function now() {
  return new Date().toISOString();
}

function ensureDbParentDir() {
  const parent = dirname(DB_PATH);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function maybeMigrateLegacyLocalDb() {
  if (DB_PATH === LEGACY_LOCAL_DB_PATH) {
    return;
  }
  if (existsSync(DB_PATH) || !existsSync(LEGACY_LOCAL_DB_PATH)) {
    return;
  }
  ensureDbParentDir();
  copyFileSync(LEGACY_LOCAL_DB_PATH, DB_PATH);
}

function openDb() {
  ensureDbParentDir();
  maybeMigrateLegacyLocalDb();
  const raw = new BetterSqlite3(DB_PATH);
  const db: AppDb = {
    close: raw.close.bind(raw),
    exec: raw.exec.bind(raw),
    query: raw.prepare.bind(raw)
  };
  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS snippets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS snippet_tags (
      snippet_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (snippet_id, tag_id),
      FOREIGN KEY (snippet_id) REFERENCES snippets(id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      tags TEXT NOT NULL,
      match_mode TEXT NOT NULL,
      target TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      body TEXT NOT NULL,
      target TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return db;
}

function setTags(db: AppDb, snippetId: number, tags: string[]) {
  const normalized = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  db.query("DELETE FROM snippet_tags WHERE snippet_id = ?").run(snippetId);

  const insertTag = db.query("INSERT OR IGNORE INTO tags (name) VALUES (?)");
  const getTag = db.query("SELECT id FROM tags WHERE name = ?");
  const link = db.query("INSERT OR IGNORE INTO snippet_tags (snippet_id, tag_id) VALUES (?, ?)");

  for (const tag of normalized) {
    insertTag.run(tag);
    const row = getTag.get(tag) as { id: number } | null;
    if (!row) continue;
    link.run(snippetId, row.id);
  }
}

function listTagsForSnippet(db: AppDb, snippetId: number) {
  const rows = db
    .query(
      `SELECT t.name
       FROM tags t
       JOIN snippet_tags st ON st.tag_id = t.id
       WHERE st.snippet_id = ?
       ORDER BY t.name`
    )
    .all(snippetId) as Array<{ name: string }>;

  return rows.map((row) => row.name);
}

function getSnippetById(db: AppDb, id: number) {
  return db.query("SELECT * FROM snippets WHERE id = ?").get(id) as SnippetRow | null;
}

function getSnippetsByIds(db: AppDb, ids: number[]) {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return db
    .query(`SELECT * FROM snippets WHERE id IN (${placeholders}) ORDER BY title`)
    .all(...ids) as SnippetRow[];
}

function getAllSnippets(db: AppDb) {
  return db.query("SELECT * FROM snippets ORDER BY title").all() as SnippetRow[];
}

function normalizeTags(tags: string[]) {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function matchesTags(snippetTags: string[], requiredTags: string[], mode: SelectionMode) {
  if (requiredTags.length === 0) return true;
  if (mode === "all") {
    return requiredTags.every((tag) => snippetTags.includes(tag));
  }
  return requiredTags.some((tag) => snippetTags.includes(tag));
}

function hasAgentScope(tags: string[]) {
  return tags.some((tag) => AGENT_TAG_KEYS.some((prefix) => tag.startsWith(prefix)) || tag === "shared:true");
}

function isAllowedForTarget(tags: string[], target: ExportTarget) {
  if (target === "markdown") {
    return true;
  }

  const normalizedTargetTags = new Set([`agent:${target}`, `runtime:${target}`, ...SHARED_AGENT_TAGS]);
  if (!hasAgentScope(tags)) {
    return true;
  }

  return tags.some((tag) => normalizedTargetTags.has(tag));
}

function filterSnippets(
  db: AppDb,
  snippets: SnippetRow[],
  options: {
    requiredTags?: string[];
    selectionMode?: SelectionMode;
    target?: ExportTarget;
  }
) {
  const requiredTags = normalizeTags(options.requiredTags ?? []);
  const selectionMode = options.selectionMode ?? "all";
  const target = options.target ?? "markdown";

  return snippets.filter((snippet) => {
    const snippetTags = listTagsForSnippet(db, snippet.id);
    return matchesTags(snippetTags, requiredTags, selectionMode) && isAllowedForTarget(snippetTags, target);
  });
}

function getSnippetsByTags(
  db: AppDb,
  tags: string[],
  options: {
    selectionMode?: SelectionMode;
    target?: ExportTarget;
  } = {}
) {
  const snippets = getAllSnippets(db);
  return filterSnippets(db, snippets, {
    requiredTags: tags,
    selectionMode: options.selectionMode ?? "any",
    target: options.target ?? "markdown"
  });
}

function renderSnippetBlocks(snippets: SnippetRow[], db: AppDb, headingLevel = 2) {
  if (snippets.length === 0) {
    return "No matching snippets found.";
  }

  const heading = "#".repeat(Math.max(1, headingLevel));
  return snippets
    .map((snippet) => {
      const tags = listTagsForSnippet(db, snippet.id);
      return `${heading} ${snippet.title}

Tags: ${tags.join(", ") || "none"}

${snippet.content}`.trim();
    })
    .join("\n\n---\n\n");
}

function normalizeTarget(value?: string): ExportTarget {
  switch (value?.toLowerCase()) {
    case undefined:
    case "markdown":
      return "markdown";
    case "codex":
      return "codex";
    case "claude":
      return "claude";
    default:
      throw new Error(`unsupported target: ${value}`);
  }
}

function normalizeInstallTarget(value?: string): ExportTarget | "all" {
  switch (value?.toLowerCase()) {
    case undefined:
      return "all";
    case "all":
      return "all";
    case "markdown":
      return "markdown";
    case "codex":
      return "codex";
    case "claude":
      return "claude";
    default:
      throw new Error(`unsupported target: ${value}`);
  }
}

function defaultOutputPath(target: ExportTarget) {
  switch (target) {
    case "codex":
      return resolve(process.cwd(), "AGENTS.md");
    case "claude":
      return resolve(process.cwd(), "CLAUDE.md");
    case "markdown":
      return resolve(process.cwd(), "instructions.md");
  }
}

function renderForTarget(snippets: SnippetRow[], db: AppDb, target: ExportTarget) {
  const body = renderSnippetBlocks(snippets, db);
  if (body === "No matching snippets found.") {
    return body;
  }

  if (target === "markdown") {
    return body;
  }

  const heading = target === "codex" ? "# AGENTS.md" : "# CLAUDE.md";
  const targetLine =
    target === "codex"
      ? "This file is managed by Instructable for Codex-compatible agents."
      : "This file is managed by Instructable for Claude Code.";

  return `${heading}

${targetLine}
Edit snippets in Instructable and regenerate this file instead of hand-editing it.

${body}
`;
}

function getManagedHeading(target: ExportTarget) {
  switch (target) {
    case "codex":
      return "# AGENTS.md";
    case "claude":
      return "# CLAUDE.md";
    case "markdown":
      return "# instructions.md";
  }
}

function getManagedNotice(target: ExportTarget) {
  switch (target) {
    case "codex":
      return "This file is managed by Instructable for Codex-compatible agents.\nEdit snippets in Instructable and regenerate this file instead of hand-editing it.";
    case "claude":
      return "This file is managed by Instructable for Claude Code.\nEdit snippets in Instructable and regenerate this file instead of hand-editing it.";
    case "markdown":
      return "This file is managed by Instructable.";
  }
}

function parseTemplateAttributes(input: string) {
  const attributes: Record<string, string> = {};
  for (const match of input.matchAll(/(\w+)="([^"]*)"/g)) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function renderTemplateQuery(
  db: AppDb,
  target: ExportTarget,
  attributes: Record<string, string>,
  flags: Record<string, string>
) {
  const queryFlags: Record<string, string> = {
    ...flags,
    tags: attributes.tags ?? "",
    target: attributes.target ?? target,
    match: attributes.match ?? "all"
  };

  if (attributes.profile) {
    queryFlags.profile = attributes.profile;
  } else {
    delete queryFlags.profile;
  }

  if (attributes.ids) {
    queryFlags.ids = attributes.ids;
  } else {
    delete queryFlags.ids;
  }

  const snippets = resolveComposeTargets(queryFlags, db, normalizeTarget(queryFlags.target));
  const headingLevel = Number(attributes.level ?? "3");
  return renderSnippetBlocks(snippets, db, Number.isInteger(headingLevel) ? headingLevel : 3);
}

function renderTemplateBody(
  db: AppDb,
  template: TemplateRow,
  target: ExportTarget,
  flags: Record<string, string>
) {
  if (template.target !== "all" && template.target !== target) {
    throw new Error(`template ${template.name} targets ${template.target}, not ${target}`);
  }

  return template.body.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawDirective: string) => {
    const directive = rawDirective.trim();

    if (directive === "selection") {
      return renderSnippetBlocks(resolveComposeTargets(flags, db, target), db, 3);
    }

    if (directive === "managed_heading") {
      return getManagedHeading(target);
    }

    if (directive === "managed_notice") {
      return getManagedNotice(target);
    }

    if (directive.startsWith("profile:")) {
      const profileName = directive.slice("profile:".length).trim();
      const snippets = resolveComposeTargets({ ...flags, profile: profileName, target }, db, target);
      return renderSnippetBlocks(snippets, db, 3);
    }

    if (directive.startsWith("query")) {
      return renderTemplateQuery(db, target, parseTemplateAttributes(directive), flags);
    }

    throw new Error(`unsupported template directive: ${directive}`);
  });
}

function ensureParentDir(filePath: string) {
  const parent = dirname(filePath);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
}

function withWriteLockHint(fn: () => void) {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error && error.message.toLowerCase().includes("database is locked")) {
      throw new Error(`${error.message}\n${SQLITE_SERIAL_WARNING}`);
    }
    throw error;
  }
}

function getProfileByName(db: AppDb, name: string) {
  return db.query("SELECT * FROM profiles WHERE name = ?").get(name) as ProfileRow | null;
}

function getTemplateByName(db: AppDb, name: string) {
  return db.query("SELECT * FROM templates WHERE name = ?").get(name) as TemplateRow | null;
}

function parseMatchMode(value?: string): SelectionMode {
  return value?.toLowerCase() === "any" ? "any" : "all";
}

function resolveTemplateFallbackTarget(flags: Record<string, string>, db: AppDb) {
  if (!flags.template) {
    return normalizeTarget(flags.target);
  }

  const template = getTemplateByName(db, flags.template.trim());
  if (!template) {
    throw new Error(`template ${flags.template} not found`);
  }

  if (flags.target) {
    return normalizeTarget(flags.target);
  }

  if (template.target === "all") {
    return "markdown";
  }

  return template.target as ExportTarget;
}

function resolveProfileContext(
  flags: Record<string, string>,
  db: AppDb,
  fallbackTarget: ExportTarget
) {
  const profileName = flags.profile?.trim();
  if (!profileName) {
    return {
      tags: normalizeTags(splitCsv(flags.tags)),
      match: parseMatchMode(flags.match),
      target: flags.target ? normalizeTarget(flags.target) : fallbackTarget
    };
  }

  const profile = getProfileByName(db, profileName);
  if (!profile) {
    throw new Error(`profile ${profileName} not found`);
  }

  const profileTarget =
    profile.target === "all" || profile.target === "markdown"
      ? fallbackTarget
      : (profile.target as ExportTarget);

  return {
    tags: normalizeTags(splitCsv(profile.tags)),
    match: profile.match_mode,
    target: flags.target ? normalizeTarget(flags.target) : profileTarget
  };
}

function cmdInit() {
  const db = openDb();
  db.close();
  console.log(`Initialized ${DB_PATH}`);
}

function cmdAdd(flags: Record<string, string>) {
  const title = flags.title?.trim();
  const content = flags.content?.trim();
  const tags = splitCsv(flags.tags);

  if (!title || !content) {
    throw new Error("add requires --title and --content");
  }

  const db = openDb();
  let snippetId = 0;
  withWriteLockHint(() => {
    const timestamp = now();
    db.query(
      `INSERT INTO snippets (title, content, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(title) DO UPDATE SET
         content = excluded.content,
         updated_at = excluded.updated_at`
    ).run(title, content, timestamp, timestamp);

    const snippet = db.query("SELECT id FROM snippets WHERE title = ?").get(title) as { id: number };
    snippetId = snippet.id;
    setTags(db, snippet.id, tags);
  });
  db.close();
  console.log(`Saved snippet ${snippetId}: ${title}`);
}

function cmdList() {
  const db = openDb();
  const rows = db.query(
    `SELECT s.id, s.title, COALESCE(GROUP_CONCAT(t.name, ', '), '') AS tags, s.updated_at
     FROM snippets s
     LEFT JOIN snippet_tags st ON st.snippet_id = s.id
     LEFT JOIN tags t ON t.id = st.tag_id
     GROUP BY s.id
     ORDER BY s.title`
  ).all() as SnippetSummary[];

  if (rows.length === 0) {
    console.log("No snippets yet.");
    db.close();
    return;
  }

  for (const row of rows) {
    console.log(`[${row.id}] ${row.title}`);
    console.log(`  tags: ${row.tags || "none"}`);
    console.log(`  updated: ${row.updated_at}`);
  }
  db.close();
}

function cmdShow(flags: Record<string, string>) {
  const id = Number(flags.id);
  if (!Number.isInteger(id)) {
    throw new Error("show requires --id");
  }

  const db = openDb();
  const snippet = getSnippetById(db, id);
  if (!snippet) {
    db.close();
    throw new Error(`snippet ${id} not found`);
  }

  console.log(renderForTarget([snippet], db, "markdown"));
  db.close();
}

function cmdUpdate(flags: Record<string, string>) {
  const id = Number(flags.id);
  if (!Number.isInteger(id)) {
    throw new Error("update requires --id");
  }

  const db = openDb();
  const existing = getSnippetById(db, id);
  if (!existing) {
    db.close();
    throw new Error(`snippet ${id} not found`);
  }

  const title = flags.title?.trim() || existing.title;
  const content = flags.content?.trim() || existing.content;
  withWriteLockHint(() => {
    db.query("UPDATE snippets SET title = ?, content = ?, updated_at = ? WHERE id = ?").run(
      title,
      content,
      now(),
      id
    );

    if (flags.tags !== undefined) {
      setTags(db, id, splitCsv(flags.tags));
    }
  });

  db.close();
  console.log(`Updated snippet ${id}`);
}

function cmdDelete(flags: Record<string, string>) {
  const id = Number(flags.id);
  if (!Number.isInteger(id)) {
    throw new Error("delete requires --id");
  }

  const db = openDb();
  withWriteLockHint(() => {
    db.query("DELETE FROM snippets WHERE id = ?").run(id);
  });
  db.close();
  console.log(`Deleted snippet ${id}`);
}

function resolveComposeTargets(
  flags: Record<string, string>,
  db: AppDb,
  fallbackTarget = normalizeTarget(flags.target)
) {
  const context = resolveProfileContext(flags, db, fallbackTarget);
  const target = context.target;
  const ids = splitCsv(flags.ids).map((value) => Number(value)).filter(Number.isInteger);
  const tags = context.tags;
  const selectionMode = context.match;

  if (ids.length > 0) {
    return filterSnippets(db, getSnippetsByIds(db, ids), {
      requiredTags: tags,
      selectionMode,
      target
    });
  }
  if (tags.length > 0) {
    return getSnippetsByTags(db, tags, { selectionMode, target });
  }
  if (target !== "markdown") {
    return filterSnippets(db, getAllSnippets(db), { target });
  }
  throw new Error("compose/export requires --ids or --tags");
}

function cmdCompose(flags: Record<string, string>) {
  const db = openDb();
  const fallbackTarget = resolveTemplateFallbackTarget(flags, db);
  const target = resolveProfileContext(flags, db, fallbackTarget).target;
  const snippets = resolveComposeTargets(flags, db, fallbackTarget);
  console.log(renderForTarget(snippets, db, target));
  db.close();
}

function cmdExport(flags: Record<string, string>) {
  const db = openDb();
  const fallbackTarget = resolveTemplateFallbackTarget(flags, db);
  const target = resolveProfileContext(flags, db, fallbackTarget).target;
  const templateName = flags.template?.trim();
  const body = templateName
    ? (() => {
        const template = getTemplateByName(db, templateName);
        if (!template) {
          throw new Error(`template ${templateName} not found`);
        }
        return renderTemplateBody(db, template, target, { ...flags, target });
      })()
    : renderForTarget(resolveComposeTargets(flags, db, fallbackTarget), db, target);
  const outputPath = flags.out ? resolve(process.cwd(), flags.out) : defaultOutputPath(target);
  ensureParentDir(outputPath);
  writeFileSync(outputPath, `${body}\n`, "utf8");
  db.close();
  console.log(`Wrote ${outputPath}`);
}

function cmdInstall(flags: Record<string, string>) {
  const targetValue = normalizeInstallTarget(flags.target);
  if (targetValue === "all") {
    cmdExport({ ...flags, target: "codex", out: flags.codexOut ?? "AGENTS.md" });
    cmdExport({ ...flags, target: "claude", out: flags.claudeOut ?? "CLAUDE.md" });
    return;
  }

  cmdExport({ ...flags, target: targetValue });
}

function cmdProfile(flags: Record<string, string>) {
  const action = flags._subcommand;
  const db = openDb();

  switch (action) {
    case "save": {
      const name = flags.name?.trim();
      if (!name) {
        db.close();
        throw new Error("profile save requires --name");
      }

      const tags = normalizeTags(splitCsv(flags.tags));
      if (tags.length === 0) {
        db.close();
        throw new Error("profile save requires --tags");
      }

      const matchMode = parseMatchMode(flags.match);
      const target = normalizeInstallTarget(flags.target);
      withWriteLockHint(() => {
        const timestamp = now();
        db.query(
          `INSERT INTO profiles (name, description, tags, match_mode, target, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             description = excluded.description,
             tags = excluded.tags,
             match_mode = excluded.match_mode,
             target = excluded.target,
             updated_at = excluded.updated_at`
        ).run(
          name,
          flags.description?.trim() || null,
          tags.join(","),
          matchMode,
          target,
          timestamp,
          timestamp
        );
      });
      db.close();
      console.log(`Saved profile ${name}`);
      return;
    }
    case "list": {
      const rows = db
        .query("SELECT name, description, tags, match_mode, target, updated_at FROM profiles ORDER BY name")
        .all() as Array<
        Pick<ProfileRow, "name" | "description" | "tags" | "match_mode" | "target" | "updated_at">
      >;

      if (rows.length === 0) {
        console.log("No profiles yet.");
        db.close();
        return;
      }

      for (const row of rows) {
        console.log(row.name);
        console.log(`  target: ${row.target}`);
        console.log(`  match: ${row.match_mode}`);
        console.log(`  tags: ${row.tags}`);
        console.log(`  description: ${row.description || "none"}`);
        console.log(`  updated: ${row.updated_at}`);
      }
      db.close();
      return;
    }
    case "show": {
      const name = flags.name?.trim();
      if (!name) {
        db.close();
        throw new Error("profile show requires --name");
      }
      const profile = getProfileByName(db, name);
      if (!profile) {
        db.close();
        throw new Error(`profile ${name} not found`);
      }
      console.log(`name: ${profile.name}`);
      console.log(`target: ${profile.target}`);
      console.log(`match: ${profile.match_mode}`);
      console.log(`tags: ${profile.tags}`);
      console.log(`description: ${profile.description || "none"}`);
      console.log(`updated: ${profile.updated_at}`);
      db.close();
      return;
    }
    case "delete": {
      const name = flags.name?.trim();
      if (!name) {
        db.close();
        throw new Error("profile delete requires --name");
      }
      withWriteLockHint(() => {
        db.query("DELETE FROM profiles WHERE name = ?").run(name);
      });
      db.close();
      console.log(`Deleted profile ${name}`);
      return;
    }
    default:
      db.close();
      throw new Error("profile requires one of: save, list, show, delete");
  }
}

function cmdTemplate(flags: Record<string, string>) {
  const action = flags._subcommand;
  const db = openDb();

  switch (action) {
    case "save": {
      const name = flags.name?.trim();
      const body = flags.body;
      if (!name || !body) {
        db.close();
        throw new Error("template save requires --name and --body");
      }

      const target = normalizeInstallTarget(flags.target);
      withWriteLockHint(() => {
        const timestamp = now();
        db.query(
          `INSERT INTO templates (name, description, body, target, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(name) DO UPDATE SET
             description = excluded.description,
             body = excluded.body,
             target = excluded.target,
             updated_at = excluded.updated_at`
        ).run(name, flags.description?.trim() || null, body, target, timestamp, timestamp);
      });
      db.close();
      console.log(`Saved template ${name}`);
      return;
    }
    case "list": {
      const rows = db
        .query("SELECT name, description, target, updated_at FROM templates ORDER BY name")
        .all() as Array<Pick<TemplateRow, "name" | "description" | "target" | "updated_at">>;

      if (rows.length === 0) {
        console.log("No templates yet.");
        db.close();
        return;
      }

      for (const row of rows) {
        console.log(row.name);
        console.log(`  target: ${row.target}`);
        console.log(`  description: ${row.description || "none"}`);
        console.log(`  updated: ${row.updated_at}`);
      }
      db.close();
      return;
    }
    case "show": {
      const name = flags.name?.trim();
      if (!name) {
        db.close();
        throw new Error("template show requires --name");
      }
      const template = getTemplateByName(db, name);
      if (!template) {
        db.close();
        throw new Error(`template ${name} not found`);
      }
      console.log(`name: ${template.name}`);
      console.log(`target: ${template.target}`);
      console.log(`description: ${template.description || "none"}`);
      console.log("body:");
      console.log(template.body);
      db.close();
      return;
    }
    case "delete": {
      const name = flags.name?.trim();
      if (!name) {
        db.close();
        throw new Error("template delete requires --name");
      }
      withWriteLockHint(() => {
        db.query("DELETE FROM templates WHERE name = ?").run(name);
      });
      db.close();
      console.log(`Deleted template ${name}`);
      return;
    }
    default:
      db.close();
      throw new Error("template requires one of: save, list, show, delete");
  }
}

function parseCommand(argv: string[]) {
  const [command, ...rest] = argv;
  if (command === "profile") {
    const [subcommand, ...profileRest] = rest;
    const parsed = parseArgs(["profile", ...profileRest]);
    return { command, flags: { ...parsed.flags, _subcommand: subcommand ?? "" } };
  }
  if (command === "template") {
    const [subcommand, ...templateRest] = rest;
    const parsed = parseArgs(["template", ...templateRest]);
    return { command, flags: { ...parsed.flags, _subcommand: subcommand ?? "" } };
  }
  return parseArgs(argv);
}

function main() {
  const { command, flags } = parseCommand(process.argv.slice(2));
  if (!command || command === "--help" || command === "-h" || flags.help === "true") {
    usage();
    return;
  }

  switch (command) {
    case "init":
      cmdInit();
      return;
    case "add":
      cmdAdd(flags);
      return;
    case "list":
      cmdList();
      return;
    case "show":
      cmdShow(flags);
      return;
    case "update":
      cmdUpdate(flags);
      return;
    case "delete":
      cmdDelete(flags);
      return;
    case "compose":
      cmdCompose(flags);
      return;
    case "export":
      cmdExport(flags);
      return;
    case "install":
      cmdInstall(flags);
      return;
    case "profile":
      cmdProfile(flags);
      return;
    case "template":
      cmdTemplate(flags);
      return;
    default:
      usage();
      throw new Error(`unknown command: ${command}`);
  }
}

main();

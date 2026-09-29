import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NodeSqliteCompatDatabase as Database } from "#node-sqlite";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database as EmDashDatabase } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { FTSManager, resetSearchMetadataCacheForTests } from "../../../src/search/fts-manager.js";
import {
	getSuggestions,
	loadSearchMetadata,
	searchCollection,
	searchWithDb,
} from "../../../src/search/query.js";

interface CountingDb {
	db: Kysely<EmDashDatabase>;
	sqlite: Database;
	queries: string[];
	reset: () => void;
}

async function setupCountingDb(): Promise<CountingDb> {
	const sqlite = new Database(":memory:");
	const queries: string[] = [];
	const db = new Kysely<EmDashDatabase>({
		dialect: new SqliteDialect({ database: sqlite }),
		log(event) {
			if (event.level === "query") {
				queries.push(event.query.sql);
			}
		},
	});

	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({
		slug: "articles",
		label: "Articles",
		supports: ["search"],
	});
	await registry.createField("articles", {
		slug: "title",
		label: "Title",
		type: "string",
		searchable: true,
	});

	const ftsManager = new FTSManager(db);
	await ftsManager.enableSearch("articles");

	const repo = new ContentRepository(db);
	await repo.create({
		type: "articles",
		slug: "hello-world",
		status: "published",
		publishedAt: new Date().toISOString(),
		data: { title: "Hello World in Emdash" },
	});

	return {
		db,
		sqlite,
		queries,
		reset: () => {
			queries.length = 0;
		},
	};
}

describe("FTS query count and metadata caching", () => {
	let ctx: CountingDb;

	beforeEach(async () => {
		resetSearchMetadataCacheForTests();
		ctx = await setupCountingDb();
		ctx.reset();
	});

	afterEach(async () => {
		resetSearchMetadataCacheForTests();
		await ctx.db.destroy();
		ctx.sqlite.close();
	});

	it("executes 2 queries on cold isolate (1 metadata + 1 FTS MATCH)", async () => {
		const res = await searchWithDb(ctx.db, "Hello");
		expect(res.items.length).toBe(1);
		expect(res.items[0]?.slug).toBe("hello-world");

		// 1 query against _emdash_collections LEFT JOIN _emdash_fields + 1 FTS query
		expect(ctx.queries.length).toBe(2);
		expect(ctx.queries[0]).toContain("_emdash_collections");
		expect(ctx.queries[1]).toContain("MATCH");
	});

	it("steady-state cross-collection search drops to exactly 1 query", async () => {
		// Prime the cache
		await searchWithDb(ctx.db, "Hello");
		ctx.reset();

		// Warm query
		const res = await searchWithDb(ctx.db, "Hello");
		expect(res.items.length).toBe(1);
		expect(ctx.queries.length).toBe(1);
		expect(ctx.queries[0]).toContain("MATCH");
	});

	it("steady-state 0-result search drops to exactly 1 query", async () => {
		// Prime the cache
		await searchWithDb(ctx.db, "Hello");
		ctx.reset();

		const res = await searchWithDb(ctx.db, "nonexistent");
		expect(res.items.length).toBe(0);
		expect(ctx.queries.length).toBe(1);
		expect(ctx.queries[0]).toContain("MATCH");
	});

	it("steady-state searchCollection drops to exactly 1 query", async () => {
		// Prime the cache
		await searchCollection(ctx.db, "articles", "Hello");
		ctx.reset();

		const res = await searchCollection(ctx.db, "articles", "Hello");
		expect(res.items.length).toBe(1);
		expect(ctx.queries.length).toBe(1);
		expect(ctx.queries[0]).toContain("MATCH");
	});

	it("steady-state getSuggestions drops to exactly 1 query", async () => {
		// Prime the cache
		await getSuggestions(ctx.db, "Hel");
		ctx.reset();

		const res = await getSuggestions(ctx.db, "Hel");
		expect(res.length).toBe(1);
		expect(res[0]?.title).toBe("Hello World in Emdash");
		expect(ctx.queries.length).toBe(1);
		expect(ctx.queries[0]).toContain("MATCH");
	});

	it("handles missing FTS table gracefully, invalidates cache, and returns empty array", async () => {
		// Drop the virtual table directly
		await ctx.db.schema.dropTable("_emdash_fts_articles").execute();
		ctx.reset();

		const res = await searchWithDb(ctx.db, "Hello");
		expect(res.items).toEqual([]);

		// Missing table triggers cache invalidation
		ctx.reset();
		// Next search should attempt to load metadata again
		await searchWithDb(ctx.db, "Hello");
		expect(ctx.queries[0]).toContain("_emdash_collections");
	});

	it("isolated DB (dbIsIsolated: true) bypasses the global cache and uses requestCached", async () => {
		// Run inside request context with dbIsIsolated: true
		await runWithContext({ editMode: false, db: ctx.db, dbIsIsolated: true }, async () => {
			const res1 = await searchWithDb(ctx.db, "Hello");
			expect(res1.items.length).toBe(1);
			expect(ctx.queries.length).toBe(2);

			ctx.reset();

			// Second call in same request scope hits requestCached
			const res2 = await searchWithDb(ctx.db, "Hello");
			expect(res2.items.length).toBe(1);
			expect(ctx.queries.length).toBe(1);
		});

		ctx.reset();

		// Outside the request context (or in a new request context), global cache was NOT primed
		const res3 = await searchWithDb(ctx.db, "Hello");
		expect(res3.items.length).toBe(1);
		// Must fetch metadata because isolated DB did not pollute global cache
		expect(ctx.queries.length).toBe(2);
		expect(ctx.queries[0]).toContain("_emdash_collections");
	});

	it("FTSManager mutations invalidate the search metadata cache", async () => {
		// Prime cache
		await searchWithDb(ctx.db, "Hello");
		ctx.reset();

		// Mutate search config via FTSManager
		const ftsManager = new FTSManager(ctx.db);
		await ftsManager.setSearchConfig("articles", {
			enabled: true,
			weights: { title: 5 },
		});
		ctx.reset();

		// Next query re-fetches metadata
		await searchWithDb(ctx.db, "Hello");
		expect(ctx.queries.length).toBe(2);
		expect(ctx.queries[0]).toContain("_emdash_collections");
	});

	it("a metadata read that races setSearchConfig does not keep the old config cached", async () => {
		let racingRead: Promise<unknown> | undefined;
		const racingDb = ctx.db.withPlugin({
			transformQuery(args) {
				if (args.node.kind === "UpdateQueryNode" && !racingRead) {
					racingRead = loadSearchMetadata(ctx.db);
				}
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});

		await new FTSManager(racingDb).setSearchConfig("articles", { enabled: false });
		await racingRead;

		expect(racingRead).toBeDefined();
		const res = await searchWithDb(ctx.db, "Hello");
		expect(res.items).toEqual([]);
	});

	it("SchemaRegistry collection updates invalidate the search metadata cache immediately", async () => {
		const reg = new SchemaRegistry(ctx.db);
		await reg.createField("articles", {
			slug: "headline",
			label: "Headline",
			type: "string",
			searchable: true,
		});

		const repo = new ContentRepository(ctx.db);
		await repo.create({
			type: "articles",
			slug: "probe-post",
			status: "published",
			publishedAt: new Date().toISOString(),
			data: { headline: "Alpha headline", title: "Original title" },
		});

		// Prime cache: titleField is not set, so result title comes from title column
		const before = await searchWithDb(ctx.db, "Alpha", { collections: ["articles"] });
		expect(before.items[0]?.title).toBe("Original title");

		// Update titleField via SchemaRegistry (not FTSManager)
		await reg.updateCollection("articles", { titleField: "headline" });

		// Should immediately reflect headline without waiting for 60s revalidation
		const after = await searchWithDb(ctx.db, "Alpha", { collections: ["articles"] });
		expect(after.items[0]?.title).toBe("Alpha headline");
	});

	it("SchemaRegistry field creations invalidate the search metadata cache immediately", async () => {
		// Prime cache
		await searchWithDb(ctx.db, "Hello");
		ctx.reset();

		// Add a new searchable field via SchemaRegistry
		const reg = new SchemaRegistry(ctx.db);
		await reg.createField("articles", {
			slug: "summary",
			label: "Summary",
			type: "string",
			searchable: true,
		});
		ctx.reset();

		// Next query re-fetches metadata immediately
		await searchWithDb(ctx.db, "Hello");
		expect(ctx.queries.length).toBe(2);
		expect(ctx.queries[0]).toContain("_emdash_collections");
	});
});

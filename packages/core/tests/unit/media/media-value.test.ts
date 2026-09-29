import { describe, it, expect } from "vitest";

import { createMediaProvider } from "../../../src/media/local-runtime.js";
import { mediaItemToValue } from "../../../src/media/types.js";
import type { MediaProviderItem, MediaValue } from "../../../src/media/types.js";

describe("mediaItemToValue", () => {
	it("copies blurhash and dominantColor onto the MediaValue", () => {
		const item: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
		};

		const value = mediaItemToValue("local", item);

		expect(value).toMatchObject({
			provider: "local",
			id: "01ABC",
			width: 1200,
			height: 800,
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
		});
	});

	it("copies caption onto the MediaValue when present", () => {
		const item: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			alt: "Photo of mountains",
			caption: "A snowy mountain range at sunset",
		};

		const value = mediaItemToValue("local", item);

		expect(value).toMatchObject({
			provider: "local",
			id: "01ABC",
			alt: "Photo of mountains",
			caption: "A snowy mountain range at sunset",
		});
	});
});

describe("local provider getEmbed", () => {
	// getEmbed never touches the database, so a stub db is enough to construct
	// the provider.
	const provider = createMediaProvider({ db: {} as never });

	it("surfaces top-level blurhash and dominantColor on the image embed", () => {
		const value: MediaValue = {
			provider: "local",
			id: "01ABC",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
			meta: { storageKey: "01ABC.jpg" },
		};

		const embed = provider.getEmbed(value);

		expect(embed).toMatchObject({
			type: "image",
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
		});
	});

	it("falls back to meta.blurhash for legacy MediaValue snapshots", () => {
		const value: MediaValue = {
			provider: "local",
			id: "01ABC",
			mimeType: "image/jpeg",
			meta: {
				storageKey: "01ABC.jpg",
				blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
				dominantColor: "#aabbcc",
			},
		};

		const embed = provider.getEmbed(value);

		expect(embed).toMatchObject({
			type: "image",
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
		});
	});
});

describe("image field schema validation", () => {
	it("preserves caption on image field value and darkVariant during schema validation", async () => {
		const { image } = await import("../../../src/fields/image.js");
		const schema = image().schema;

		const payload = {
			id: "01ABC",
			src: "/media/photo.jpg",
			alt: "A mountain",
			caption: "Snowy peak in winter",
			width: 1200,
			height: 800,
			darkVariant: {
				id: "01DEF",
				src: "/media/photo-dark.jpg",
				caption: "Snowy peak at night",
			},
		};

		const parsed = schema.parse(payload);
		expect(parsed).toEqual(payload);
		expect(parsed?.caption).toBe("Snowy peak in winter");
		expect(parsed?.darkVariant?.caption).toBe("Snowy peak at night");
	});
});

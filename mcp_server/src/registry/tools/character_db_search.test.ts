// mcp_server/src/registry/tools/character_db_search.test.ts
import { mock } from "bun:test";

const userId = "00000000-0000-0000-0000-000000000010";

const mockSheet = {
  name: "Spider-Man",
  imageUrl: null,
  shortDescription: "Friendly neighborhood superhero",
  firstAppearanceDate: "1962-08-10",
  personality: {
    personalityTraits: ["brave", "witty"],
    backstory: "Bitten by a radioactive spider",
    relationships: {},
    speechPatterns: [],
    values: ["responsibility"],
    fears: ["losing loved ones"],
    goals: ["protect New York"],
    notableQuotes: ["With great power comes great responsibility"],
    abilities: ["wall-crawling", "web-slinging"],
    copingStyle: ["humor"],
    knowledgeScope: {},
  },
};

const mockRawRow = {
  id: "00000000-0000-0000-0000-000000000001",
  userId,
  name: "Spider-Man",
  sheet: mockSheet,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
  archivedAt: null,
  score: 0.45,
};

const mockQueryRaw = mock(async () => [mockRawRow]);
const mockFindPictures = mock(async (): Promise<Array<{
  characterId: string;
  size: number;
  url: string;
}>> => []);

mock.module("../../db.js", () => ({
  prisma: {
    $queryRaw: mockQueryRaw,
    characterPicture: { findMany: mockFindPictures },
  },
}));

import { describe, test, expect, beforeEach } from "bun:test";
import { characterDbSearchHandler } from "./character_db_search";
import { userIdStorage } from "../../auth/context";
import { SavedCharacterRecordSchema, type CharacterDbSearchInput } from "@open-ormus/shared";

describe("characterDbSearchHandler", () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockQueryRaw.mockImplementation(async () => [mockRawRow]);
    mockFindPictures.mockReset();
    mockFindPictures.mockImplementation(async () => []);
  });

  test("returns matched characters shaped as SavedCharacterRecord[]", async () => {
    const input: CharacterDbSearchInput = { query: "spiderman", limit: 10 };
    const result = await userIdStorage.run(userId, () =>
      characterDbSearchHandler(input)
    );

    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("00000000-0000-0000-0000-000000000001");
    expect(result[0]?.name).toBe("Spider-Man");
    expect(result[0]?.userId).toBe(userId);
    expect(result[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result[0]?.updatedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result[0]?.pictures).toEqual([]);
    expect(SavedCharacterRecordSchema.array().parse(result)).toEqual(result);
    // score must NOT be present in output
    expect((result[0] as Record<string, unknown>)["score"]).toBeUndefined();
  });

  test("returns empty array when no characters match", async () => {
    mockQueryRaw.mockImplementation(async () => []);
    const result = await userIdStorage.run(userId, () =>
      characterDbSearchHandler({ query: "zzznomatch", limit: 10 })
    );
    expect(result).toEqual([]);
    expect(mockFindPictures).not.toHaveBeenCalled();
  });

  test("returns each matched character's pictures in search-result order", async () => {
    const secondId = "00000000-0000-0000-0000-000000000002";
    mockQueryRaw.mockImplementation(async () => [mockRawRow, { ...mockRawRow, id: secondId }]);
    mockFindPictures.mockImplementation(async () => [
      { characterId: secondId, size: 128, url: "https://example.com/second.webp" },
      { characterId: mockRawRow.id, size: 48, url: "https://example.com/first-48.webp" },
      { characterId: mockRawRow.id, size: 512, url: "https://example.com/first-512.webp" },
    ]);

    const result = await userIdStorage.run(userId, () =>
      characterDbSearchHandler({ query: "spider", limit: 5 })
    );

    expect(result.map((record) => record.id)).toEqual([mockRawRow.id, secondId]);
    expect(result[0]?.pictures).toEqual([
      { size: 48, url: "https://example.com/first-48.webp" },
      { size: 512, url: "https://example.com/first-512.webp" },
    ]);
    expect(result[1]?.pictures).toEqual([
      { size: 128, url: "https://example.com/second.webp" },
    ]);
    expect(SavedCharacterRecordSchema.array().parse(result)).toEqual(result);
    expect(mockFindPictures).toHaveBeenCalledTimes(1);
    expect(mockFindPictures).toHaveBeenCalledWith({
      where: { userId, characterId: { in: [mockRawRow.id, secondId] } },
    });
  });

  test("calls $queryRaw once per invocation", async () => {
    await userIdStorage.run(userId, () =>
      characterDbSearchHandler({ query: "spider", limit: 5 })
    );
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  test("throws if userId not in context", async () => {
    await expect(
      characterDbSearchHandler({ query: "spider", limit: 10 })
    ).rejects.toThrow("userId not in context");
  });
});

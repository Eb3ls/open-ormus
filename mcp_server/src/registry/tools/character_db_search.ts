// mcp_server/src/registry/tools/character_db_search.ts
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Prisma } from "../../generated/prisma/client.js";
import {
  CharacterDbSearchInputShape,
  CharacterSearchResultSchema,
  TOOL_DESCRIPTIONS,
  type CharacterDbSearchInput,
  type CharacterPicture,
  type SavedCharacterRecord,
} from "@open-ormus/shared";
import { prisma } from "../../db.js";
import { userIdStorage } from "../../auth/context.js";

// Shape of a row returned by the raw pg_trgm similarity query.
// Timestamps come back as Date objects from the pg driver.
// score is excluded from the public SavedCharacterRecord output.
type RawRow = {
  id: string;
  userId: string;
  name: string;
  sheet: unknown;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
  score: number;
};

export async function characterDbSearchHandler(
  args: CharacterDbSearchInput
): Promise<SavedCharacterRecord[]> {
  const userId = userIdStorage.getStore();
  if (!userId) throw new Error("userId not in context");

  const { query, limit } = args;

  const rows = await prisma.$queryRaw<RawRow[]>(Prisma.sql`
    SELECT
      id,
      user_id        AS "userId",
      name,
      sheet,
      created_at     AS "createdAt",
      updated_at     AS "updatedAt",
      archived_at    AS "archivedAt",
      GREATEST(
        similarity(name, ${query}),
        similarity(sheet->>'shortDescription', ${query})
      ) AS score
    FROM characters
    WHERE user_id = ${userId}::uuid
      AND archived_at IS NULL
      AND (
        similarity(name, ${query}) > 0.15
        OR similarity(sheet->>'shortDescription', ${query}) > 0.15
      )
    ORDER BY score DESC
    LIMIT ${Prisma.raw(String(limit))}
  `);

  if (rows.length === 0) return [];
  const pictures = await prisma.characterPicture.findMany({
    where: { userId, characterId: { in: rows.map((row) => row.id) } },
  });
  const picturesByCharacter = new Map<string, CharacterPicture[]>();
  for (const picture of pictures) {
    const entries = picturesByCharacter.get(picture.characterId) ?? [];
    entries.push({ size: picture.size, url: picture.url });
    picturesByCharacter.set(picture.characterId, entries);
  }

  return rows.map((row) => ({
    id: row.id,
    userId: row.userId,
    name: row.name,
    sheet: CharacterSearchResultSchema.parse(row.sheet),
    pictures: picturesByCharacter.get(row.id) ?? [],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    archivedAt: row.archivedAt?.toISOString() ?? null,
  }));
}

export function register(server: McpServer): void {
  server.tool(
    "mcp__openormus__character_find",
    TOOL_DESCRIPTIONS.character_find,
    CharacterDbSearchInputShape,
    async (args: CharacterDbSearchInput) => ({
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(await characterDbSearchHandler(args)),
        },
      ],
    })
  );
}

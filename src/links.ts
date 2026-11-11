export interface Links {
  id: string;
  /** The edited memo as one growing MP3: plays on click, while it is still being made. */
  listen: string;
  listen_original: string;
  /** The card page with the sketch and transcript. */
  card: string;
}

export function briefLinks(base: string, id: string): Links {
  const card = `${base}/b/${id}`;
  return { id, listen: `${card}/edited.mp3`, listen_original: `${card}/original.mp3`, card };
}

/** The chat line: two tappable words on one line. The card link is not part of it. */
export const listenMarkdown = (l: Pick<Links, "listen" | "listen_original">): string => `[Listen](${l.listen}) \u00b7 [Original](${l.listen_original})`;

/** The old two-line form, for `--format plain`. */
export const listenLines = (l: Pick<Links, "listen" | "listen_original">): string => `Listen: ${l.listen}\nOriginal: ${l.listen_original}`;

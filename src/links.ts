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

/** The two chat lines, in this order. The card link is not part of them. */
export const listenLines = (l: Links): string => `Listen: ${l.listen}\nListen original: ${l.listen_original}`;

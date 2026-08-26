/** A git author/committer identity, attached to runs so commits made inside a
 *  session are attributed to the human who prompted them. */
export interface GitIdentity {
  name: string;
  email: string;
}

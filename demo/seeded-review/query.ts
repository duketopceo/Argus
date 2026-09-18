// Seeded showcase file — intentionally contains an injection-shaped bug.
// Never merge.
export function findUser(db: { query(sql: string): unknown }, id: string) {
  return db.query('SELECT * FROM users WHERE id = ' + id)
}

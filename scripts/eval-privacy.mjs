import { basename, isAbsolute, relative, resolve, sep } from 'node:path'

export function redactEvalOutput(text, repo, home) {
  return text.split(repo).join('<repo>').split(home).join('<home>')
}

export function displayCorpusPath(path, repo) {
  const absolute = resolve(path)
  const rel = relative(repo, absolute)
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? basename(absolute) : rel
}

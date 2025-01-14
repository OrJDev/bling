// @ts-nocheck

// All credit for this work goes to the amazing Next.js team.
// https://github.com/vercel/next.js/blob/canary/packages/next/build/babel/plugins/next-ssg-transform.ts
// This is adapted to work with any serverFn$() calls and transpile it into multiple api function for a file.

import crypto from 'crypto'
import nodePath from 'path'
import * as esbuild from 'esbuild'

const INLINE_SERVER_ROUTE_PREFIX = '/_m'

export function compileServerFile$({ code }) {
  let compiled = esbuild.buildSync({
    stdin: {
      contents: code,
    },
    write: false,
    metafile: true,
    platform: 'neutral',
    format: 'esm',
    // loader: {
    //   '.js': 'jsx',
    // },
    logLevel: 'silent',
  })

  let exps

  for (let key in compiled.metafile.outputs) {
    if (compiled.metafile.outputs[key].entryPoint) {
      exps = compiled.metafile.outputs[key].exports
    }
  }

  if (!exps) {
    throw new Error('Could not find entry point to detect exports')
  }

  console.log(exps)

  compiled = esbuild.buildSync({
    stdin: {
      contents: `${exps
        .map((key) => `export const ${key} = undefined`)
        .join('\n')}`,
    },
    write: false,
    platform: 'neutral',
    format: 'esm',
  })

  console.log(compiled.outputFiles[0].text)

  return {
    code: compiled.outputFiles[0].text,
  }
}

export function compileServerFn$({ code, compiler, id, ssr }) {
  const compiledCode = compiler(code, id, (source: any, id: any) => ({
    plugins: [
      [
        transformServerFn$,
        {
          ssr,
          root: process.cwd(),
          minify: process.env.NODE_ENV === 'production',
        },
      ],
    ].filter(Boolean),
  }))

  return {
    code: compiledCode,
  }
}

export function transformServerFn$({ types: t, template }) {
  return {
    visitor: {
      Program: {
        enter(path, state) {
          state.refs = new Set()
          state.done = false
          state.servers = 0
          path.traverse(
            {
              VariableDeclarator(variablePath, variableState) {
                if (variablePath.node.id.type === 'Identifier') {
                  const local = variablePath.get('id')
                  if (isIdentifierReferenced(local)) {
                    variableState.refs.add(local)
                  }
                } else if (variablePath.node.id.type === 'ObjectPattern') {
                  const pattern = variablePath.get('id')
                  const properties = pattern.get('properties')
                  properties.forEach((p) => {
                    const local = p.get(
                      p.node.type === 'ObjectProperty'
                        ? 'value'
                        : p.node.type === 'RestElement'
                        ? 'argument'
                        : (function () {
                            throw new Error('invariant')
                          })()
                    )
                    if (isIdentifierReferenced(local)) {
                      variableState.refs.add(local)
                    }
                  })
                } else if (variablePath.node.id.type === 'ArrayPattern') {
                  const pattern = variablePath.get('id')
                  const elements = pattern.get('elements')
                  elements.forEach((e) => {
                    let local
                    if (e.node && e.node.type === 'Identifier') {
                      local = e
                    } else if (e.node && e.node.type === 'RestElement') {
                      local = e.get('argument')
                    } else {
                      return
                    }
                    if (isIdentifierReferenced(local)) {
                      variableState.refs.add(local)
                    }
                  })
                }
              },
              CallExpression: (path) => {
                if (
                  path.node.callee.type === 'Identifier' &&
                  path.node.callee.name === 'serverFn$'
                ) {
                  const serverFn = path.get('arguments')[0]
                  const serverFnOpts = path.get('arguments')[1]
                  let program = path.findParent((p) => t.isProgram(p))
                  let statement = path.findParent((p) =>
                    program.get('body').includes(p)
                  )
                  let decl = path.findParent(
                    (p) =>
                      p.isVariableDeclarator() ||
                      p.isFunctionDeclaration() ||
                      p.isObjectProperty()
                  )
                  let serverIndex = state.servers++
                  let hasher = state.opts.minify ? hashFn : (str) => str
                  const fName = state.filename
                    .replace(state.opts.root, '')
                    .slice(1)

                  const hash = hasher(nodePath.join(fName, String(serverIndex)))

                  serverFn.traverse({
                    MemberExpression(path) {
                      let obj = path.get('object')
                      if (
                        obj.node.type === 'Identifier' &&
                        obj.node.name === 'serverFn$'
                      ) {
                        obj.replaceWith(t.identifier('$$ctx'))
                        return
                      }
                    },
                  })

                  if (serverFn.node.type === 'ArrowFunctionExpression') {
                    const body = serverFn.get('body')

                    if (body.node.type !== 'BlockStatement') {
                      const block = t.blockStatement([
                        t.returnStatement(body.node),
                      ])
                      body.replaceWith(block)
                    }

                    serverFn.replaceWith(
                      t.functionExpression(
                        t.identifier('$$serverHandler' + serverIndex),
                        serverFn.node.params,
                        serverFn.node.body,
                        false,
                        true
                      )
                    )
                  }

                  if (serverFn.node.type === 'FunctionExpression') {
                    serverFn
                      .get('body')
                      .unshiftContainer(
                        'body',
                        t.variableDeclaration('const', [
                          t.variableDeclarator(
                            t.identifier('$$ctx'),
                            t.thisExpression()
                          ),
                        ])
                      )
                  }

                  const pathname = nodePath
                    .join(
                      INLINE_SERVER_ROUTE_PREFIX,
                      hash,
                      decl?.node.id?.elements?.[0]?.name ??
                        decl?.node.id?.name ??
                        decl?.node.key?.name ??
                        'fn'
                    )
                    .replaceAll('\\', '/')

                  if (state.opts.ssr) {
                    statement.insertBefore(
                      template(`
                      const $$server_module${serverIndex} = serverFn$.createHandler(%%source%%, "${pathname}", %%options%%);
                      serverFn$.registerHandler("${pathname}", $$server_module${serverIndex});
                      `)({
                        source: serverFn.node,
                        options:
                          serverFnOpts?.node || t.identifier('undefined'),
                      })
                    )
                  } else {
                    statement.insertBefore(
                      template(
                        `
                        ${
                          process.env.TEST_ENV === 'client'
                            ? `serverFn$.registerHandler("${pathname}", serverFn$.createHandler(%%source%%, "${pathname}", %%options%%));`
                            : ``
                        }
                        const $$server_module${serverIndex} = serverFn$.createFetcher("${pathname}", %%options%%);`,
                        {
                          syntacticPlaceholders: true,
                        }
                      )(
                        process.env.TEST_ENV === 'client'
                          ? {
                              source: serverFn.node,
                              options:
                                serverFnOpts?.node || t.identifier('undefined'),
                            }
                          : {
                              options:
                                serverFnOpts?.node || t.identifier('undefined'),
                            }
                      )
                    )
                  }
                  path.replaceWith(
                    t.identifier(`$$server_module${serverIndex}`)
                  )
                }
              },
              FunctionDeclaration: markFunction,
              FunctionExpression: markFunction,
              ArrowFunctionExpression: markFunction,
              ImportSpecifier: function (path, state) {
                // Rewrite imports to `@tanstack/bling` to `@tanstack/bling/server` during SSR
                if (state.opts.ssr && path.node.imported.name === 'serverFn$') {
                  const importDeclaration = path.findParent((p) =>
                    p.isImportDeclaration()
                  )
                  if (importDeclaration) {
                    importDeclaration.node.source.value += '/server'
                  }
                }
                markImport(path, state)
              },
              ImportDefaultSpecifier: markImport,
              ImportNamespaceSpecifier: markImport,
            },
            state
          )

          const refs = state.refs
          let count
          function sweepFunction(sweepPath) {
            const ident = getIdentifier(sweepPath)
            if (
              ident &&
              ident.node &&
              refs.has(ident) &&
              !isIdentifierReferenced(ident)
            ) {
              ++count
              if (
                t.isAssignmentExpression(sweepPath.parentPath) ||
                t.isVariableDeclarator(sweepPath.parentPath)
              ) {
                sweepPath.parentPath.remove()
              } else {
                sweepPath.remove()
              }
            }
          }
          function sweepImport(sweepPath) {
            const local = sweepPath.get('local')
            if (refs.has(local) && !isIdentifierReferenced(local)) {
              ++count
              sweepPath.remove()
              if (!state.opts.ssr) {
                if (sweepPath.parent.specifiers.length === 0) {
                  sweepPath.parentPath.remove()
                }
              }
            }
          }
          do {
            path.scope.crawl()
            count = 0
            path.traverse({
              VariableDeclarator(variablePath) {
                if (variablePath.node.id.type === 'Identifier') {
                  const local = variablePath.get('id')
                  if (refs.has(local) && !isIdentifierReferenced(local)) {
                    ++count
                    variablePath.remove()
                  }
                } else if (variablePath.node.id.type === 'ObjectPattern') {
                  const pattern = variablePath.get('id')
                  const beforeCount = count
                  const properties = pattern.get('properties')
                  properties.forEach((p) => {
                    const local = p.get(
                      p.node.type === 'ObjectProperty'
                        ? 'value'
                        : p.node.type === 'RestElement'
                        ? 'argument'
                        : (function () {
                            throw new Error('invariant')
                          })()
                    )
                    if (refs.has(local) && !isIdentifierReferenced(local)) {
                      ++count
                      p.remove()
                    }
                  })
                  if (
                    beforeCount !== count &&
                    pattern.get('properties').length < 1
                  ) {
                    variablePath.remove()
                  }
                } else if (variablePath.node.id.type === 'ArrayPattern') {
                  const pattern = variablePath.get('id')
                  const beforeCount = count
                  const elements = pattern.get('elements')
                  elements.forEach((e) => {
                    let local
                    if (e.node && e.node.type === 'Identifier') {
                      local = e
                    } else if (e.node && e.node.type === 'RestElement') {
                      local = e.get('argument')
                    } else {
                      return
                    }
                    if (refs.has(local) && !isIdentifierReferenced(local)) {
                      ++count
                      e.remove()
                    }
                  })
                  if (
                    beforeCount !== count &&
                    pattern.get('elements').length < 1
                  ) {
                    variablePath.remove()
                  }
                }
              },
              FunctionDeclaration: sweepFunction,
              FunctionExpression: sweepFunction,
              ArrowFunctionExpression: sweepFunction,
              ImportSpecifier: sweepImport,
              ImportDefaultSpecifier: sweepImport,
              ImportNamespaceSpecifier: sweepImport,
            })
          } while (count)
        },
      },
    },
  }
}

function getIdentifier(path) {
  const parentPath = path.parentPath
  if (parentPath.type === 'VariableDeclarator') {
    const pp = parentPath
    const name = pp.get('id')
    return name.node.type === 'Identifier' ? name : null
  }
  if (parentPath.type === 'AssignmentExpression') {
    const pp = parentPath
    const name = pp.get('left')
    return name.node.type === 'Identifier' ? name : null
  }
  if (path.node.type === 'ArrowFunctionExpression') {
    return null
  }
  return path.node.id && path.node.id.type === 'Identifier'
    ? path.get('id')
    : null
}

function isIdentifierReferenced(ident) {
  const b = ident.scope.getBinding(ident.node.name)
  if (b && b.referenced) {
    if (b.path.type === 'FunctionDeclaration') {
      return !b.constantViolations
        .concat(b.referencePaths)
        .every((ref) => ref.findParent((p) => p === b.path))
    }
    return true
  }
  return false
}

function markFunction(path, state) {
  const ident = getIdentifier(path)
  if (ident && ident.node && isIdentifierReferenced(ident)) {
    state.refs.add(ident)
  }
}

function markImport(path, state) {
  const local = path.get('local')
  // if (isIdentifierReferenced(local)) {
  state.refs.add(local)
  // }
}

function hashFn(str) {
  return crypto
    .createHash('shake256', { outputLength: 5 /* bytes = 10 hex digits*/ })
    .update(str)
    .digest('hex')
}

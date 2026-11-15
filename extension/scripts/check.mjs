import {readFileSync, readdirSync, statSync, existsSync} from 'node:fs';
import {dirname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dynamic-island@adamshannag.github.io');
const GLOBALS = new Set([
    'global', 'console', 'JSON', 'Math', 'Date', 'Number', 'String', 'Object', 'Array', 'Map', 'Set', 'Error',
    'Promise', 'TextDecoder', 'TextEncoder', 'Uint8Array', 'encodeURI', 'encodeURIComponent', 'decodeURIComponent',
    'parseInt', 'parseFloat', 'isNaN', 'Infinity', 'NaN', 'undefined', 'Symbol', 'RegExp', 'Boolean', 'imports',
    'log', 'logError', 'print', 'setTimeout', 'clearTimeout',
]);

const errors = [];
const fail = (file, node, msg) => errors.push(`${relative(ROOT, file)}:${node?.loc?.start.line ?? 0}: ${msg}`);

function files(dir) {
    return readdirSync(dir).flatMap(name => {
        const p = join(dir, name);
        if (statSync(p).isDirectory())
            return name.startsWith('.') ? [] : files(p);
        return p.endsWith('.js') ? [p] : [];
    });
}

const parsed = new Map();
for (const file of files(ROOT)) {
    try {
        parsed.set(file, acorn.parse(readFileSync(file, 'utf8'), {ecmaVersion: 'latest', sourceType: 'module', locations: true}));
    } catch (e) {
        errors.push(`${relative(ROOT, file)}: syntax: ${e.message}`);
    }
}

function exportsOf(ast) {
    const names = new Set();
    for (const node of ast.body) {
        if (node.type === 'ExportDefaultDeclaration')
            names.add('default');
        if (node.type !== 'ExportNamedDeclaration')
            continue;
        const d = node.declaration;
        if (d?.declarations)
            d.declarations.forEach(v => names.add(v.id.name));
        else if (d?.id)
            names.add(d.id.name);
        node.specifiers.forEach(s => names.add(s.exported.name));
    }
    return names;
}

function patternNames(p, out) {
    if (!p)
        return;
    if (p.type === 'Identifier')
        out.add(p.name);
    else if (p.type === 'ObjectPattern')
        p.properties.forEach(q => patternNames(q.type === 'RestElement' ? q.argument : q.value, out));
    else if (p.type === 'ArrayPattern')
        p.elements.forEach(e => patternNames(e, out));
    else if (p.type === 'RestElement')
        patternNames(p.argument, out);
    else if (p.type === 'AssignmentPattern')
        patternNames(p.left, out);
}

function declared(ast) {
    const names = new Set();
    walk.full(ast, node => {
        switch (node.type) {
        case 'VariableDeclarator':
            patternNames(node.id, names);
            break;
        case 'FunctionDeclaration':
        case 'FunctionExpression':
        case 'ArrowFunctionExpression':
            if (node.id)
                names.add(node.id.name);
            node.params.forEach(p => patternNames(p, names));
            break;
        case 'ClassDeclaration':
        case 'ClassExpression':
            if (node.id)
                names.add(node.id.name);
            break;
        case 'CatchClause':
            patternNames(node.param, names);
            break;
        case 'ImportSpecifier':
        case 'ImportDefaultSpecifier':
        case 'ImportNamespaceSpecifier':
            names.add(node.local.name);
            break;
        }
    });
    return names;
}

function checkReferences(file, ast) {
    const names = declared(ast);
    walk.ancestor(ast, {
        Identifier(node, _state, ancestors) {
            const parent = ancestors[ancestors.length - 2];
            if (!parent)
                return;
            if (parent.type === 'MemberExpression' && parent.property === node && !parent.computed)
                return;
            if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') &&
                parent.key === node && !parent.computed && !(parent.type === 'Property' && parent.shorthand))
                return;
            if (parent.type === 'ExportSpecifier' || parent.type.startsWith('Import') || parent.type === 'LabeledStatement')
                return;
            if (!names.has(node.name) && !GLOBALS.has(node.name))
                fail(file, node, `'${node.name}' is not defined`);
        },
    });
}

function checkImports(file, ast) {
    for (const node of ast.body) {
        if (node.type !== 'ImportDeclaration' || !node.source.value.startsWith('.'))
            continue;
        const target = resolve(dirname(file), node.source.value);
        if (!existsSync(target)) {
            fail(file, node, `cannot resolve ${node.source.value}`);
            continue;
        }
        const exported = parsed.has(target) ? exportsOf(parsed.get(target)) : new Set();
        for (const s of node.specifiers) {
            const name = s.type === 'ImportDefaultSpecifier' ? 'default' : s.imported?.name;
            if (name && !exported.has(name))
                fail(file, s, `${node.source.value} has no export '${name}'`);
        }
    }
}

function checkClassCollisions(file, ast) {
    walk.full(ast, cls => {
        if (cls.type !== 'ClassDeclaration' && cls.type !== 'ClassExpression')
            return;
        const methods = new Set(cls.body.body
            .filter(m => m.type === 'MethodDefinition' && m.kind === 'method' && !m.static)
            .map(m => m.key.name));
        walk.simple(cls.body, {
            AssignmentExpression(node) {
                const l = node.left;
                if (l.type === 'MemberExpression' && l.object.type === 'ThisExpression' && !l.computed && methods.has(l.property.name))
                    fail(file, node, `this.${l.property.name} is both a method and a field`);
            },
        });
    });
}

function dbusMethods() {
    const src = readFileSync(join(ROOT, 'lib', 'dbus.js'), 'utf8');
    return new Set([...src.matchAll(/<method name="(\w+)"/g)].map(m => m[1]));
}

function checkDbusCalls(file, ast, methods) {
    walk.simple(ast, {
        CallExpression(node) {
            const callee = node.callee;
            const name = callee.type === 'MemberExpression' && !callee.computed ? callee.property.name : null;
            if (!['call', 'callJson', 'fetch'].includes(name))
                return;
            const arg = node.arguments[0];
            if (arg?.type === 'Literal' && typeof arg.value === 'string' && /^[A-Z]/.test(arg.value) && !methods.has(arg.value))
                fail(file, node, `D-Bus method ${arg.value} is not declared in lib/dbus.js`);
        },
    });
}

const methods = dbusMethods();
for (const [file, ast] of parsed) {
    checkImports(file, ast);
    checkReferences(file, ast);
    checkClassCollisions(file, ast);
    checkDbusCalls(file, ast, methods);
}

if (errors.length) {
    console.error(errors.join('\n'));
    process.exit(1);
}
console.log(`ok: ${parsed.size} modules, ${methods.size} D-Bus methods`);

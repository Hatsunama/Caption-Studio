import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
const repo = fileURLToPath(new URL('../', import.meta.url));

// This is source evidence for scoped app adoption, not a runtime restriction or
// proof that the reusable component supports RN replacing its native host.
test('current app ScrollView callers use fixed axes; layout horizontal booleans are separate', () => {
  const callers = [];
  function visitDirectory(directory) {
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      const file=path.join(directory,entry.name);
      if(entry.isDirectory())visitDirectory(file);
      else if(entry.name.endsWith('.tsx')) {
        const source=fs.readFileSync(file,'utf8');
        if(!source.includes('spring-scroll-view')&&!source.includes('TimelineNativeScrollView'))continue;
        if(entry.name==='timeline-native-gesture.tsx')continue; // reusable forwarding boundary
        const tree=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
        const names=new Set();
        for(const statement of tree.statements)if(ts.isImportDeclaration(statement))
          for(const element of statement.importClause?.namedBindings?.elements??[]) {
            const exported=element.propertyName?.text??element.name.text;
            if(exported==='SpringScrollView'||exported==='TimelineNativeScrollView'||exported==='FlatList')names.add(element.name.text);
          }
        function visit(node) {
          if((ts.isJsxOpeningElement(node)||ts.isJsxSelfClosingElement(node))&&names.has(node.tagName.getText(tree))) {
            const axis=node.attributes.properties.find(p=>p.name?.text==='horizontal');
            assert.equal(axis?.initializer, undefined, `${file}: reconsider scoped stable-host evidence if an actual scroll axis becomes dynamic`);
            callers.push({file:path.relative(repo,file).replaceAll('\\','/'),horizontal:!!axis});
          }
          ts.forEachChild(node,visit);
        }
        visit(tree);
      }
    }
  }
  visitDirectory(path.join(repo,'src'));
  assert.ok(callers.length>=20);
  const horizontal=callers.filter(c=>c.horizontal);
  assert.deepEqual(horizontal.map(c=>path.basename(c.file)).sort(),['layer-timeline.tsx','notices.tsx','persisted-horizontal-scroll.tsx']);
  console.log('fixed-axis app source evidence', JSON.stringify({scrolls:callers.length,horizontal}));
});

'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
// Pure parser/serializer checks. Never execute a shell or expand large mappings.
test('published shell-quote guard rejects harmless multiline text after a comment',()=>{
 const {quote}=require('shell-quote');
 for(const separator of ['\n','\r','\u2028','\u2029']) {
   assert.throws(()=>quote(['caption',{comment:'note'},'two'+separator+'lines']),TypeError);
 }
 assert.equal(typeof quote(['caption',{comment:'note'},'single line']),'string');
});
test('published source-map-js guard rejects fractional and negative section columns',()=>{
 const {SourceMapConsumer}=require('source-map-js');
 const map={version:3,sources:[],names:[],mappings:''};
 for(const column of [0.5,-1]) {
   assert.throws(()=>new SourceMapConsumer({version:3,sections:[{offset:{line:0,column},map}]}),/non-negative integers/);
 }
 assert.doesNotThrow(()=>new SourceMapConsumer({version:3,sections:[{offset:{line:0,column:0},map}]}));
});

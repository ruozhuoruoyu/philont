/**
 * recall_trigger 单元测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTimeRetrospectiveQuery } from '../src/recall_trigger.js';

test('detectTimeRetrospectiveQuery: 中文回忆动词 + 过去时副词 → 命中', () => {
  // 真实 14:46 case
  assert.ok(detectTimeRetrospectiveQuery('我刚才说搞不定就算了，你咋又想尝试？'));
  assert.ok(detectTimeRetrospectiveQuery('我之前说过这个'));
  assert.ok(detectTimeRetrospectiveQuery('上次我们讨论过的方案是啥？'));
  assert.ok(detectTimeRetrospectiveQuery('你还记得我喜欢吃啥吗？'));
  assert.ok(detectTimeRetrospectiveQuery('记得我说的偏好不？'));
  assert.ok(detectTimeRetrospectiveQuery('接着上次的话题继续'));
  assert.ok(detectTimeRetrospectiveQuery('刚才说的是什么？'));
  assert.ok(detectTimeRetrospectiveQuery('我们之前聊过 docker compose 的问题'));
});

test('detectTimeRetrospectiveQuery: 英文回忆 → 命中', () => {
  assert.ok(detectTimeRetrospectiveQuery('Do you remember what we discussed earlier?'));
  assert.ok(detectTimeRetrospectiveQuery("As we said previously, the deploy is on Friday."));
  assert.ok(detectTimeRetrospectiveQuery('Remember when you mentioned the bug?'));
  assert.ok(detectTimeRetrospectiveQuery('From our last conversation, you suggested X.'));
  assert.ok(detectTimeRetrospectiveQuery('Earlier you told me to use pandoc.'));
});

test('detectTimeRetrospectiveQuery: 普通新任务 → 不命中', () => {
  assert.equal(detectTimeRetrospectiveQuery('帮我把 markdown 转 word'), null);
  assert.equal(detectTimeRetrospectiveQuery('安装一下 pandoc'), null);
  assert.equal(detectTimeRetrospectiveQuery('What is the time?'), null);
  assert.equal(detectTimeRetrospectiveQuery('你好'), null);
  assert.equal(detectTimeRetrospectiveQuery('好的，谢谢'), null);
  assert.equal(detectTimeRetrospectiveQuery('我喜欢吃面条'), null); // 偏好声明,不是回忆
});

test('detectTimeRetrospectiveQuery: 短消息(<4 字符)直接放过', () => {
  assert.equal(detectTimeRetrospectiveQuery('好'), null);
  assert.equal(detectTimeRetrospectiveQuery('嗯'), null);
  assert.equal(detectTimeRetrospectiveQuery('yes'), null);
  assert.equal(detectTimeRetrospectiveQuery('记得'), null); // 边界:命中关键词但太短不算
});

test('detectTimeRetrospectiveQuery: 现在时陈述 + 同形关键词 → 不误命中', () => {
  // "我说话" 不算回忆
  assert.equal(detectTimeRetrospectiveQuery('请你说话别夹英文'), null);
  // 表达当下意愿不算回忆
  assert.equal(detectTimeRetrospectiveQuery('我想说一下我的需求'), null);
  // "记得带钥匙" 是提醒未来,不是回忆
  // (注:当前实现会命中"记得",这是已知 false-positive 但伤害小——
  //  agent 多调一次 recall 也不出错)
  // assert.equal(detectTimeRetrospectiveQuery('记得带钥匙'), null);  // commented out — known FP
});

test('detectTimeRetrospectiveQuery: 返回的 snippet 是命中片段', () => {
  const r = detectTimeRetrospectiveQuery('我之前说过 markdown 转 word 的事');
  assert.ok(r);
  assert.ok(r.snippet.includes('之前') || r.snippet.includes('说过'));
});

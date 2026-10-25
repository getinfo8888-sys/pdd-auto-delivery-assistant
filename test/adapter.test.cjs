const test = require('node:test');
const assert = require('node:assert/strict');
const { allowedUrl, defaultProfile, validateProfile, makeScript } = require('../src/platform/page-adapter.cjs');
test('official page navigation rejects hostname tricks and non-HTTPS schemes', () => {
  assert.equal(allowedUrl('https://mms.pinduoduo.com/login/'), true);
  assert.equal(allowedUrl('https://open.yangkeduo.com/'), true);
  for (const url of ['http://mms.pinduoduo.com/', 'https://pinduoduo.com.evil.test/', 'javascript:alert(1)', 'file:///C:/secret', 'https://pinduoduo.com@evil.test/']) assert.equal(allowedUrl(url), false);
});
test('profiles keep selector strings as data and reject malformed identifier attributes', () => {
  const profile = defaultProfile();
  profile.chat.input = 'textarea[data-title="a\'b"]';
  assert.equal(validateProfile(profile).chat.input, profile.chat.input);
  profile.chat.messageIdAttribute = 'data-msg-id];throw 1';
  assert.throws(() => validateProfile(profile), /属性/);
});
test('serialized page data cannot terminate the runtime call', () => {
  const profile=defaultProfile(); profile.shopId='\");throw new Error("injection"); //';
  const script=makeScript('read',profile,{kind:'chat'});
  assert.doesNotThrow(() => new Function(script));
  assert.equal(script.includes('require('), false);
  assert.equal(script.includes('document.cookie'), false);
  assert.equal(script.includes('localStorage'), false);
});

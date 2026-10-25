'use strict';
const {randomInt}=require('node:crypto');
const characters=['\u200b','\u200c','\u200d'];
const MAX_CONTENT_LENGTH=20000;
const INVISIBLE_PROFILE='zero-width-0-100-v1';
const pad=value=>String(value).padStart(2,'0');
const LEGAL_TAIL=/^(?:| | [\u200b-\u200d]{17,41}|  \u200b[\u200b-\u200d]{1,100}|\n\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\n〔消息标记：[A-Z0-9]{6}〕)?)$/u;

function bodySpaceCandidates(content) {
  const protectedRanges=[];
  const protect=pattern=>{for(const match of content.matchAll(pattern))protectedRanges.push([match.index,match.index+match[0].length]);};
  for(const match of content.matchAll(/\S+/gu))if(match[0].includes('://')||match[0].includes('\\')||/^www\./iu.test(match[0])||/\.[a-z]{2,}(?:[/?#:]|$)/iu.test(match[0]))protectedRanges.push([match.index,match.index+match[0].length]);
  protect(/`[^`]*`/gu);
  protect(/^[^\r\n]*(?:提取码|提取代码|提取密码|访问码|密码|口令|兑换码|激活码|验证码|取件码|卡密)[^\r\n]*$/gmu);
  protectedRanges.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  const merged=[];for(const range of protectedRanges){const last=merged.at(-1);if(last&&range[0]<=last[1])last[1]=Math.max(last[1],range[1]);else merged.push([...range]);}
  const result=[];let previous='',offset=0,rangeIndex=0;
  for(const char of content) {
    while(rangeIndex<merged.length&&merged[rangeIndex][1]<=offset)rangeIndex++;
    const protectedGap=rangeIndex<merged.length&&offset>merged[rangeIndex][0]&&offset<merged[rangeIndex][1];
    if(offset>0&&offset<content.length-1&&/\p{Script=Han}/u.test(previous)&&/\p{Script=Han}/u.test(char)&&!protectedGap)result.push(offset);
    offset+=char.length;previous=char;
  }
  return result;
}

function spacedBody(content,offsets) {
  let result=content;
  for(let index=offsets.length-1;index>=0;index--)result=result.slice(0,offsets[index])+' '+result.slice(offsets[index]);
  return result;
}

function isValidReplyPayload(content,wireContent,bodySpaceOffsets) {
  if(typeof content!=='string'||typeof wireContent!=='string'||wireContent.length>MAX_CONTENT_LENGTH)return false;
  let body=content;
  if(bodySpaceOffsets!==undefined) {
    if(!Array.isArray(bodySpaceOffsets)||bodySpaceOffsets.length!==3)return false;
    const candidates=new Set(bodySpaceCandidates(content));
    if(bodySpaceOffsets.some((offset,index)=>!Number.isSafeInteger(offset)||!candidates.has(offset)||index>0&&offset<=bodySpaceOffsets[index-1]))return false;
    body=spacedBody(content,bodySpaceOffsets);
  }
  return wireContent.startsWith(body)&&LEGAL_TAIL.test(wireContent.slice(body.length));
}

// Keep the rule text separate from the payload. Cooldowns, matching and order
// delivery use the original text; only a reply's durable send intent varies.
function formatReplyContent(content,{enabled=false,mode='invisible',now=Date.now(),pick=randomInt,bodySpaces=false}={}) {
  if(typeof content!=='string')throw TypeError('答复正文必须是文本');
  if(!enabled)return {content,mode:'none'};
  if(!['invisible','time','time-tag'].includes(mode))throw TypeError('答复末尾内容选项不正确');
  if(mode==='invisible' && /[a-z][a-z0-9+.-]*:\/\/\S+$/iu.test(content))return {content,mode:'none',note:'url_tail'};
  let suffix;
  if(mode==='time'||mode==='time-tag') {
    const date=new Date(now);
    if(!Number.isFinite(date.getTime()))throw TypeError('答复时间不正确');
    suffix=`\n${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    if(mode==='time-tag') {
      const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';let tag='';
      for(let index=0;index<6;index++)tag+=alphabet[pick(0,alphabet.length)];
      suffix+='\n〔消息标记：'+tag+'〕';
    }
  } else {
    const length=pick(0,101);
    // The caller contributes one space. The helper contributes another space,
    // U+200B, and N random characters when N>0; N=0 contributes no helper text.
    suffix=length===0?' ':'  \u200b';
    for(let index=0;index<length;index++)suffix+=characters[pick(0,characters.length)];
  }
  if(content.length+suffix.length>MAX_CONTENT_LENGTH)return {content,mode:'none',note:'length_limit'};
  if(bodySpaces&&mode==='time-tag') {
    const candidates=bodySpaceCandidates(content);
    if(candidates.length<3)return {content:content+suffix,mode,note:'no_safe_body_spaces'};
    if(content.length+3+suffix.length>MAX_CONTENT_LENGTH)return {content:content+suffix,mode,note:'body_spaces_length_limit'};
    const offsets=[];
    for(let index=0;index<3;index++){const selected=pick(0,candidates.length);offsets.push(candidates.splice(selected,1)[0]);}
    offsets.sort((a,b)=>a-b);
    return {content:spacedBody(content,offsets)+suffix,mode,bodySpaceOffsets:offsets};
  }
  return {content:content+suffix,mode};
}
module.exports={formatReplyContent,isValidReplyPayload,INVISIBLE_PROFILE};

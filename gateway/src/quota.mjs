import { validQuota } from './validation.mjs';
export class MemoryTokenBuckets {
  constructor({ now = () => performance.now(), maxKeys = 1000, idleMs = 300000 } = {}) { if(typeof now!=='function'||!Number.isInteger(maxKeys)||maxKeys<1||maxKeys>100000||!Number.isInteger(idleMs)||idleMs<1000||idleMs>86400000)throw new Error('invalid quota store configuration');this.now=now;this.maxKeys=maxKeys;this.idleMs=idleMs;this.buckets=new Map(); }
  clock(){const value=this.now();if(!Number.isFinite(value))throw new Error('invalid quota clock');return value;}
  cleanup(now=this.clock()) { for (const [k,b] of this.buckets) if (Math.max(0,now-b.seen) >= this.idleMs) this.buckets.delete(k); }
  take(key, { rate, burst }) {
    if(typeof key!=='string'||!validQuota({rate,burst}))throw new Error('invalid quota input');const now=this.clock(); this.cleanup(now); let b=this.buckets.get(key);
    if (!b) { if (this.buckets.size >= this.maxKeys) return { ok:false, overflow:true, retryAfter:1, limit:burst, remaining:0, reset:1 }; b={tokens:burst,last:now,seen:now}; this.buckets.set(key,b); }
    const elapsed=Math.max(0,now-b.last);b.tokens=Math.min(burst,b.tokens+elapsed*rate/1000);if(now>b.last)b.last=now;if(now>b.seen)b.seen=now;
    if (b.tokens < 1) { const wait=Math.max(1,Math.ceil((1-b.tokens)/rate));const full=Math.max(0,Math.ceil((burst-b.tokens)/rate)); return {ok:false,retryAfter:wait,limit:burst,remaining:0,reset:full}; }
    b.tokens-=1; return {ok:true,limit:burst,remaining:Math.floor(b.tokens),reset:Math.max(0,Math.ceil((burst-b.tokens)/rate))};
  }
}

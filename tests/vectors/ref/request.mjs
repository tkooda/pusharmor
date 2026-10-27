// PA-Sig request signing (catalog r10, General): ECDSA over
// "PA-REQ1\n" + METHOD + "\n" + path + "\n" + PA-Time + "\n" + raw body bytes.
import { cat } from './bytes.mjs';
import { sign, verify } from './p256.mjs';

export function reqBytes(method, path, paTime, body) {
  return cat('PA-REQ1\n' + method + '\n' + path + '\n' + paTime + '\n', body);
}

export const signRequest = (sk, method, path, paTime, body) => sign(sk, reqBytes(method, path, paTime, body));

// PA-Time must be 13 decimal digits (component-worker-r1 section 12).
export function verifyRequest(signPub, method, path, paTime, body, sig) {
  if (!/^[1-9][0-9]{12}$/.test(paTime)) return false;
  return verify(signPub, reqBytes(method, path, paTime, body), sig);
}

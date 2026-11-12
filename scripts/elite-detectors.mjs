// elite-detectors.js — generic static checks for elite-catch bug classes
// Each detector: (src, path) => [] hits. Pure regex/ordering, no deps. Explainable.
function idx(src, re){ const m = re.exec(src); return m ? m.index : -1; }

export function d1_slippageContamination(src, path=""){
  // Class: slippage check on aggregate balance that includes pre-funded user collateral.
  // VULN shape: user intake (TransferFrom user / userCollateralAmount) BEFORE require(... >= minAmountOut)
  // FIX shapes: (a) check-then-collect ordering, or (b) before/after delta (collateralBefore).
  if(!/minAmountOut/.test(src)) return [];
  if(!/balanceOf\s*\(\s*address\s*\(\s*this\s*\)/.test(src)) return [];
  const reqM = /require\s*\([^;]*minAmountOut[^;]*\)/.exec(src);
  if(!reqM) return [];
  const reqIdx = reqM.index;
  // user intake signals
  const intakeRes = [/safeTransferFrom\s*\([^)]*user[^)]*\)/i, /userCollateralAmount\s*>\s*0[\s\S]{0,200}?safeTransferFrom/i, /TransferFrom\([^)]*user/i];
  let intakeIdx = -1;
  for(const re of intakeRes){ const m = re.exec(src); if(m && (intakeIdx<0 || m.index<intakeIdx)) intakeIdx = m.index; }
  // also direct: userCollateralAmount transfer line
  if(intakeIdx<0){
    const m2 = /userCollateralAmount/.exec(src);
    // only count if there's a transfer near it before require
    if(m2 && m2.index < reqIdx && /safeTransferFrom/i.test(src.slice(Math.max(0,m2.index-300), m2.index+300))) intakeIdx = m2.index;
  }
  if(intakeIdx>=0 && intakeIdx < reqIdx){
    // check for delta-snapshot escape hatch: collateralBefore/balanceBefore measured and require uses delta
    const pre = src.slice(0, reqIdx);
    if(/collateralBefore|balanceBefore|swapOutput\s*=.*-.*[Bb]efore/.test(pre)) return [];
    return [{detector:"D1-slippage-contamination", path, reqLine: lineOf(src,reqIdx), intakeLine: lineOf(src,intakeIdx),
      why:"user-collateral intake occurs BEFORE minAmountOut check on aggregate balanceOf(address(this)) — swap shortfall masked by user funds"}];
  }
  return [];
}

export function d2_grossBorrow(src, path=""){
  // Class: flash-loan callback borrows full amount ignoring loan tokens returned by swap route.
  // VULN: encodeCall(borrow,(amount,...)) with full 'amount' and no netting vars.
  if(!/flashLoan/i.test(src)) return [];
  if(!/swapper|swapData|multicall/i.test(src)) return []; // teleport-style (repay-only, no swap route) has no return-input surface
  if(!/borrow/i.test(src)) return [];
  const hasNetting = /borrowAmount|returnedLoan|loanBalanceBefore|balanceBeforeSwap|amount\s*-\s*Math\.min|amount\s*-\s*returned/i.test(src);
  const grossM = /encodeCall\s*\([^)]*borrow[\s\S]{0,120}?\(\s*amount\s*,/.exec(src) || /borrow\s*\(\s*amount\s*,/.exec(src);
  if(grossM && !hasNetting){
    return [{detector:"D2-gross-borrow", path, line: lineOf(src,grossM.index),
      why:"borrows full flash-loan 'amount' with no subtraction of loan tokens returned by swap route (unused input strands as operator balance / borrower debt)"}];
  }
  return [];
}

export function d3_frozenReserve(src, path=""){
  // Class: emergency-Frozen entry reaches internal reserve branch with no pause gate.
  // Impl pattern (all 3 Twyne vaults): _handleExcessCredit impl has release branch (repay) + reserve branch (.borrow).
  // Reserve branch must be gated to Active-only; report L1: it is not (acknowledged).
  const code = stripComments(src);
  const hIdx = code.indexOf("_handleExcessCredit");
  if(hIdx<0) return [];
  const body = code.slice(hIdx, hIdx+2500);
  if(!/\.borrow\s*\(/.test(body)) return [];
  // borrow must sit in an 'else' reserve branch (vaultAssets < invariant) — scope check
  const bIdx = body.search(/\.borrow\s*\(/);
  const win = body.slice(Math.max(0,bIdx-700), bIdx+100);
  if(/pauseState\s*\(\s*\)\s*==\s*PauseState\.Active|whenNotPaused\s*\(\s*PauseState\.Active|require.*[Pp]ause|isFrozen|Frozen/.test(win)) return [];
  return [{detector:"D3-frozen-reserve", path, line: lineOf(src, src.indexOf("_handleExcessCredit")),
    why:"_handleExcessCredit impl contains an unguarded .borrow reserve branch — Frozen-permitted unwinds (repay/withdraw/redeem via whenNotPaused(Paused)) can reserve fresh CLP credit during an emergency freeze"}];
}

export function d4_cursorRegression(src, path=""){
  // Class: time/epoch cursor param written to state without monotonicity guard.
  if(!/_week\b|_systemWeek/.test(src)) return [];
  const writeM = /(lastUpdateWeek\s*=\s*_week\b|lastUpdateWeek\s*=\s*_systemWeek\b|acctData\.lastUpdateWeek\s*=\s*_week|acctData\.lastUpdateWeek\s*=\s*_systemWeek)/.exec(src);
  if(!writeM){
    // broader: any cursor write of param name
    const m2 = /lastUpdateWeek\s*=\s*_\w+/.exec(src);
    if(!m2) return [];
    // fall through to guard check on whole file fn scope (approx: 1500 chars before write)
    const pre = stripComments(src).slice(Math.max(0,m2.index-2000), m2.index);
    if(/require\s*\(\s*_systemWeek\s*>\s*lastUpdateWeek|require\s*\(\s*_week\s*>=|_week\s*>=\s*systemWeek|if\s*\(\s*_week\s*>=\s*systemWeek/.test(pre)) return [];
    return [{detector:"D4-cursor-regression", path, line: lineOf(src,m2.index), why:"cursor write to lastUpdateWeek without monotonicity guard nearby — _week < lastUpdate can bypass logic yet update cursor"}];
  }
  const pre = stripComments(src).slice(Math.max(0,writeM.index-2000), writeM.index);
  if(/require\s*\(\s*_systemWeek\s*>\s*lastUpdateWeek|require\s*\(\s*_week\s*>=|specified week is older|if\s*\(\s*_week\s*>=\s*systemWeek/.test(pre)) return [];
  return [{detector:"D4-cursor-regression", path, line: lineOf(src,writeM.index),
    why:"_week/_systemWeek written to lastUpdateWeek without require(_week >= lastUpdate) — stale param bypasses checkpoint yet moves cursor (lock/weight-keep)"}];
}

export function d5_zeroWeight(src, path=""){
  // Class: weighted-stake entry mints weight with no amount/weight sanity (zero -> unlimited / div0-adjacent).
  if(!/(depositAsWeighted|stakeAsMaxWeighted)/.test(src)) return [];
  const fnIdx = src.search(/(depositAsWeighted|stakeAsMaxWeighted)/);
  const win = src.slice(fnIdx, fnIdx+2500);
  if(/require\s*\([^)]*_amount\s*>\s*[01][^)]*\)/.test(win)) return [];
  if(/require\s*\([^)]*weight\s*>\s*0/.test(win)) return [];
  return [{detector:"D5-zero-weight", path, line: lineOf(src,fnIdx),
    why:"weighted-stake entry lacks _amount/weight >0 sanity — zero-weight path can mint unbounded weight"}];
}

function stripComments(t){ return t.replace(/\/\/[^\n]*/g, "").replace(/\/\*[\s\S]*?\*\//g, ""); }
function lineOf(src, idx){ return src.slice(0,idx).split("\n").length; }
export const ALL = [d1_slippageContamination, d2_grossBorrow, d3_frozenReserve, d4_cursorRegression, d5_zeroWeight];

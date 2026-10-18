/** The easing and clamping every move in the demo shares. */
import { Easing, interpolate } from 'remotion';

export const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
export const ease = Easing.inOut(Easing.cubic);

/** 0 to 1 between `t0` and `t1`, eased, held at either end. */
export const progress = (t: number, t0: number, t1: number) => interpolate(t, [t0, t1], [0, 1], { ...clamp, easing: ease });

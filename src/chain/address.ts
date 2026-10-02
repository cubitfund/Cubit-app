export const sameAddress = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

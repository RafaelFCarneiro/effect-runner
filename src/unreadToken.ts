/** "No token recorded yet": a distinct value so a store whose token is `undefined` still compares. Internal. */
export const UNREAD_TOKEN: unique symbol = Symbol('unreadChangeToken');

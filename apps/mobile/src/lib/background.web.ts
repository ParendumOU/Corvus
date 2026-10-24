/** The web build has no background checks. */
export async function enableNotifications(_on: boolean): Promise<boolean> {
  return false;
}

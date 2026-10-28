import { Redirect } from 'expo-router';

/** The old Ask Corvus screen (links and shortcuts to it): a new conversation of the Assist tab. */
export default function AskScreen() {
  return <Redirect href={{ pathname: '/chat/[id]', params: { id: 'new' } }} />;
}

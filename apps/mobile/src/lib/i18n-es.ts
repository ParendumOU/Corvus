/** Spanish texts of the app, by their English text (see lib/i18n.ts). */
export const ES: Record<string, string> = {
  // Navigation
  Library: 'Biblioteca',
  Settings: 'Ajustes',
  'Pair with a computer': 'Emparejar con un ordenador',
  'Save or send a page': 'Guardar o enviar una página',
  'Watched pages': 'Páginas vigiladas',
  'Ask Corvus': 'Pregunta a Corvus',

  // Home
  'Opens the page. Long press to open it in your browser app.': 'Abre la página. Mantén pulsado para abrirla en tu navegador.',
  Pinned: 'Fijada',
  Group: 'Grupo',
  '1 tab': '1 pestaña',
  '{n} tabs': '{n} pestañas',
  'updated {when}': 'actualizado {when}',
  'your computer': 'tu ordenador',
  'Tabs from your computers': 'Pestañas de tus ordenadores',
  "Your computer's Corvus, in your pocket.": 'El Corvus de tu ordenador, en tu bolsillo.',
  'Not paired with a computer yet': 'Aún no está emparejado con un ordenador',
  'On your computer, open Corvus Settings, then Sync, and choose “Pair a phone”. Then scan the code here.':
    'En tu ordenador, abre los Ajustes de Corvus, luego Sincronización, y elige «Emparejar un móvil». Después escanea el código aquí.',
  'Sent to this phone': 'Enviado a este móvil',
  'From {device}': 'De {device}',
  'Send a page to your computer': 'Enviar una página a tu ordenador',
  'Waiting for {computer} to open it · sent {when}': 'Esperando a que {computer} la abra · enviada {when}',
  Cancel: 'Cancelar',
  'Watch a page for changes or for a price to drop.': 'Vigila una página para saber si cambia o si baja un precio.',
  '{n} watched · {changed} changed in the last day': '{n} vigiladas · {changed} cambiaron en el último día',
  'Find a tab': 'Buscar una pestaña',
  'No tab matches “{query}”.': 'Ninguna pestaña coincide con «{query}».',
  'No open tabs from your computers yet. Corvus shares a computer’s open tabs while Sync is on there; pull down to refresh.':
    'Aún no hay pestañas abiertas de tus ordenadores. Corvus comparte las pestañas abiertas de un ordenador mientras tenga la sincronización activada; desliza hacia abajo para actualizar.',
  'Loading…': 'Cargando…',

  // Ask
  Remove: 'Quitar',
  Ask: 'Preguntar',
  'Ask anything': 'Pregunta lo que quieras',
  'Ask {computer}': 'Preguntar a {computer}',
  "Your computer answers with Corvus's AI search, using its own AI provider, while Corvus is open there.":
    'Tu ordenador responde con la búsqueda con IA de Corvus, usando su propio proveedor de IA, mientras Corvus esté abierto allí.',
  'Pair this phone with your computer first: your computer answers the questions.':
    'Empareja antes este móvil con tu ordenador: es tu ordenador quien responde a las preguntas.',
  'No computer on this sync chain yet.': 'Aún no hay ningún ordenador en esta cadena de sincronización.',
  'Waiting for {computer} (Corvus must be open there)…': 'Esperando a {computer} (Corvus tiene que estar abierto allí)…',
  '{computer} is answering…': '{computer} está respondiendo…',
  'Answered by {computer}': 'Respondido por {computer}',
  '{computer} could not answer: {error}': '{computer} no pudo responder: {error}',
  'something went wrong': 'algo salió mal',
  'That did not work: {error}': 'No ha funcionado: {error}',

  // Send
  'Pair this phone with your computer first, then share the page again.': 'Empareja antes este móvil con tu ordenador y vuelve a compartir la página.',
  Page: 'Página',
  'That is not a web address.': 'Eso no es una dirección web.',
  'Title (optional)': 'Título (opcional)',
  'Send to a computer': 'Enviar a un ordenador',
  'It opens in a new tab there the next time Corvus syncs (within a minute while it is running).':
    'Se abre allí en una pestaña nueva la próxima vez que Corvus sincronice (en menos de un minuto si está abierto).',
  Send: 'Enviar',
  'Send to {computer}': 'Enviar a {computer}',
  'Keep it': 'Guardarla',
  'Saved on every device. For the reading list, a computer with Corvus fetches the article.':
    'Se guarda en todos tus dispositivos. Para la lista de lectura, un ordenador con Corvus descarga el artículo.',
  'Save to reading list': 'Guardar en la lista de lectura',
  Bookmark: 'Añadir a favoritos',
  'Watch for changes': 'Vigilar cambios',

  // Pair
  'Could not join the sync chain: {error}': 'No se pudo unir a la cadena de sincronización: {error}',
  'On your computer, open Corvus Settings, then Sync, and choose “Pair a phone”. Anyone with that code can read your synced data, so pair only your own phone.':
    'En tu ordenador, abre los Ajustes de Corvus, luego Sincronización, y elige «Emparejar un móvil». Quien tenga ese código puede leer tus datos sincronizados: empareja solo tu propio móvil.',
  'Scan the code': 'Escanea el código',
  'Use the camera': 'Usar la cámara',
  'Or enter it by hand': 'O escríbelo a mano',
  'Enter the code': 'Escribe el código',
  'Sync server address': 'Dirección del servidor de sincronización',
  'Recovery phrase (24 words), or the pairing code': 'Frase de recuperación (24 palabras) o el código de emparejamiento',
  Pair: 'Emparejar',
  'That is not a Corvus pairing code. On your computer, open Settings, then Sync, and choose “Pair a phone”.':
    'Eso no es un código de emparejamiento de Corvus. En tu ordenador, abre Ajustes, luego Sincronización, y elige «Emparejar un móvil».',
  'The recovery phrase is not valid: check the 24 words.': 'La frase de recuperación no es válida: revisa las 24 palabras.',
  'Enter the sync server address, starting with https:// or http://.': 'Escribe la dirección del servidor de sincronización, empezando por https:// o http://.',
  'Android phone': 'Móvil Android',
  Phone: 'Móvil',

  // Watches
  Yes: 'Sí',
  'Not yet': 'Aún no',
  'Not known yet': 'Aún no se sabe',
  'Notify me when {condition}': 'Avisarme cuando {condition}',
  Paused: 'En pausa',
  'Checked {when} by {computer}': 'Comprobada {when} por {computer}',
  'Not checked yet: a computer with Corvus checks it soon': 'Aún sin comprobar: un ordenador con Corvus la comprobará pronto',
  'Changed {when}': 'Cambió {when}',
  'Could not check it: {error}': 'No se pudo comprobar: {error}',
  'Could not add it: {error}': 'No se pudo añadir: {error}',
  'Watch a page': 'Vigilar una página',
  'Your computers check it and tell you when it changes, or only when your condition comes true (“the price is under 100”).':
    'Tus ordenadores la comprueban y te avisan cuando cambia, o solo cuando se cumple tu condición («el precio baja de 100»).',
  'Notify me when… (optional)': 'Avisarme cuando… (opcional)',
  'Watch this page': 'Vigilar esta página',
  'No watched pages yet.': 'Aún no hay páginas vigiladas.',
  'every {n} min': 'cada {n} min',
  'every hour': 'cada hora',
  'every {n} hours': 'cada {n} horas',
  'every day': 'cada día',
  'every {n} days': 'cada {n} días',
  '{page} changed': '{page} ha cambiado',

  // Library
  'Find a bookmark': 'Buscar un favorito',
  'Find in your reading list': 'Buscar en tu lista de lectura',
  'Search history': 'Buscar en el historial',
  Bookmarks: 'Favoritos',
  'Reading list': 'Lista de lectura',
  History: 'Historial',
  Folder: 'Carpeta',
  'This folder is empty.': 'Esta carpeta está vacía.',
  '{n} min read': '{n} min de lectura',
  'saved {when}': 'guardado {when}',
  read: 'leído',
  'Nothing in your reading list matches “{query}”.': 'Nada en tu lista de lectura coincide con «{query}».',
  'Your reading list is empty. Save articles in reader mode on your computer, or share a link to Corvus here.':
    'Tu lista de lectura está vacía. Guarda artículos en el modo lectura de tu ordenador o comparte un enlace con Corvus aquí.',
  'Mark unread': 'Marcar como no leído',
  'Mark read': 'Marcar como leído',
  'Nothing in your history matches “{query}”.': 'Nada en tu historial coincide con «{query}».',
  'No history from your computers yet.': 'Aún no hay historial de tus ordenadores.',
  'Show more ({n} left)': 'Mostrar más (quedan {n})',
  'Pair this phone with your computer to see your bookmarks and reading list here.':
    'Empareja este móvil con tu ordenador para ver aquí tus favoritos y tu lista de lectura.',
  Today: 'Hoy',
  Yesterday: 'Ayer',
  '{weekday} {day} {month}': '{weekday} {day} de {month}',
  Sunday: 'domingo',
  Monday: 'lunes',
  Tuesday: 'martes',
  Wednesday: 'miércoles',
  Thursday: 'jueves',
  Friday: 'viernes',
  Saturday: 'sábado',
  January: 'enero',
  February: 'febrero',
  March: 'marzo',
  April: 'abril',
  May: 'mayo',
  June: 'junio',
  July: 'julio',
  August: 'agosto',
  September: 'septiembre',
  October: 'octubre',
  November: 'noviembre',
  December: 'diciembre',

  // Settings
  'Unpair this phone?': '¿Desemparejar este móvil?',
  'It leaves the sync chain and forgets the recovery phrase. Your computer keeps all its data.':
    'Sale de la cadena de sincronización y olvida la frase de recuperación. Tu ordenador conserva todos sus datos.',
  Unpair: 'Desemparejar',
  Sync: 'Sincronización',
  'Paired as “{name}” with {server}.': 'Emparejado como «{name}» con {server}.',
  'Devices on this sync chain': 'Dispositivos de esta cadena de sincronización',
  'Could not list them right now.': 'Ahora mismo no se pueden mostrar.',
  '(this phone)': '(este móvil)',
  'seen {when}': 'visto {when}',
  'Unpair this phone': 'Desemparejar este móvil',
  'Not paired. What the phone and your computer share is end-to-end encrypted: the sync server only stores ciphertext.':
    'Sin emparejar. Lo que comparten el móvil y tu ordenador va cifrado de extremo a extremo: el servidor de sincronización solo guarda datos cifrados.',
  Notifications: 'Notificaciones',
  'Pages your computer sends to this phone, and watched pages that change. The phone checks about every 15 minutes in the background, when the system allows it.':
    'Páginas que tu ordenador envía a este móvil y páginas vigiladas que cambian. El móvil lo comprueba en segundo plano unas cada 15 minutos, cuando el sistema lo permite.',
  'Notifications are blocked for Corvus: allow them in the system settings, then turn this on again.':
    'Las notificaciones de Corvus están bloqueadas: permítelas en los ajustes del sistema y vuelve a activar esto.',
  About: 'Acerca de',
  'Corvus for mobile {version}': 'Corvus para móvil {version}',

  // Session
  'This phone is not paired with a computer.': 'Este móvil no está emparejado con un ordenador.',
  'Could not reach the sync server: {error}': 'No se pudo conectar con el servidor de sincronización: {error}',
  'Your sync server does not support sending pages yet: update it to the latest Corvus sync server.':
    'Tu servidor de sincronización aún no permite enviar páginas: actualízalo a la última versión del servidor de Corvus.',
  'Your sync server does not support questions yet: update it to the latest Corvus sync server.':
    'Tu servidor de sincronización aún no permite preguntas: actualízalo a la última versión del servidor de Corvus.',

  // Times
  'just now': 'ahora mismo',
  '{n} min ago': 'hace {n} min',
  '{n} h ago': 'hace {n} h',
  '{n} d ago': 'hace {n} d',
};

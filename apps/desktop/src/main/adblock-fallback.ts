/**
 * Offline fallback filter list. Used when EasyList + EasyPrivacy cannot be fetched on first run
 * (no network, CI) so the blocker always does something out of the box. Once the full lists are
 * fetched and cached under userData they take over. EasyList-compatible network syntax.
 */
export const FALLBACK_FILTERS = `! Corvus built-in fallback ad/tracker filters
! --- Ad serving / exchanges ---
||doubleclick.net^
||googlesyndication.com^
||googleadservices.com^
||google-analytics.com^
||googletagmanager.com^
||googletagservices.com^
||adservice.google.com^
||pagead2.googlesyndication.com^
||partner.googleadservices.com^
||2mdn.net^
||adnxs.com^
||adsrvr.org^
||advertising.com^
||adform.net^
||adroll.com^
||amazon-adsystem.com^
||casalemedia.com^
||criteo.com^
||criteo.net^
||pubmatic.com^
||rubiconproject.com^
||openx.net^
||moatads.com^
||taboola.com^
||outbrain.com^
||scorecardresearch.com^
||serving-sys.com^
||smartadserver.com^
||yieldmo.com^
||zedo.com^
||media.net^
||bidswitch.net^
||sharethrough.com^
||3lift.com^
||contextweb.com^
||gumgum.com^
||indexww.com^
! --- Tracking / analytics ---
||doubleclick.net^$third-party
||quantserve.com^
||quantcount.com^
||hotjar.com^
||mouseflow.com^
||fullstory.com^
||mixpanel.com^
||segment.com^
||segment.io^
||branch.io^
||amplitude.com^
||chartbeat.com^
||newrelic.com^
||nr-data.net^
||optimizely.com^
||crazyegg.com^
||bugsnag.com^
||sentry.io^$third-party
||facebook.com/tr^
||connect.facebook.net^
||analytics.twitter.com^
||bat.bing.com^
||clarity.ms^
||yandex.ru/metrika^
||mc.yandex.ru^
||stats.g.doubleclick.net^
||app-measurement.com^
! --- Common ad path cosmetics ---
##.adsbygoogle
##.ad-banner
##.advertisement
###ad-container
`;

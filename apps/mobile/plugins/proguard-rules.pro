# Keep rules for R8 that the libraries do not ship themselves (plugins/with-r8-rules.js appends them
# to the generated android/app/proguard-rules.pro).
#
# Some libraries' own rules keep a class without its members, which keeps its no-argument
# constructor only in R8's compatibility mode. In full mode (the default) the constructor goes, and
# creating the class by reflection fails at run time.

# Room creates each database through the constructor of its generated _Impl class: without it,
# WorkManager (expo-background-task) failed at start-up with "Failed to create an instance of class
# androidx.work.impl.WorkDatabase" (Corvus for mobile 0.3.0 and 0.4.0 closed at once for this).
-keep class * extends androidx.room.RoomDatabase { <init>(); }
# WorkManager creates each work request's input merger by its class name.
-keep class * extends androidx.work.InputMerger { <init>(); }

Pod::Spec.new do |s|
  s.name = 'MontiDeviceKey'
  s.version = '0.1.0'
  s.summary = 'MONTI hardware device key'
  s.license = 'MIT'
  s.homepage = 'https://monti.app'
  s.author = 'MONTI'
  s.source = { :git => 'https://monti.app', :tag => s.version.to_s }
  s.source_files = 'ios/Sources/**/*.{swift,h,m}'
  # 16.0 is the floor the app already targets; nothing here needs newer.
  s.ios.deployment_target = '16.0'
  s.dependency 'Capacitor'
  s.swift_version = '5.9'
end
